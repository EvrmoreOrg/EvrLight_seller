// Last-resort manual recovery tool -- NOT wired into the running service,
// never imported by seller.js. Use this only if seller-lease-state.json
// itself is ever lost or corrupted (the normal path is: seller.js just
// resumes automatically on restart, see startSeller()/resumeOpenLeases()).
//
// Since every refund keypair seller.js issues is derived deterministically
// (HMAC-SHA256(SELLER_PRIV_KEY, "refund:" + counter) -- see
// deriveRefundPrivkeyHex() in seller.js), the private key behind any
// refund_pubkey seller.js ever published is always reproducible from
// SELLER_PRIV_KEY alone, given the counter that produced it. This script
// brute-forces that counter (fast -- a few thousand HMACs is instant) given
// a target refund_pubkey, which is never secret: it's published verbatim as
// the offer's own "pubkey" field, so it's recoverable from relay history
// (status broadcasts persist on the addressable kind indefinitely, tagged
// by offer_id) or from this seller's own past console logs even if
// seller-lease-state.json is gone.
//
// Usage:
//   SELLER_PRIV_KEY=<hex or WIF> node recover-refund-key.js \
//     --refund-pubkey <hex> [--network testnet|mainnet] [--max-counter 100000]
//
// If you also know the HTLC's other parameters (everything needed to spend
// its OP_ELSE/timelock branch), add:
//     --buyer-pubkey <hex> --payment-hash <hex> --timelock <n> \
//     --funding-txid <hex> --funding-vout <n> --amount <sats> \
//     --to-address <address> [--broadcast]
// to also build the refund transaction. Without --broadcast, this only
// prints the raw signed transaction hex for you to inspect/broadcast
// yourself -- nothing here ever broadcasts without that explicit flag.

const crypto = require('crypto');
const axios = require('axios');
const evrmorejs = require('evrmorejs-lib');
const { ECPairFactory } = require('ecpair');
const tinysecp = require('tiny-secp256k1');
const ECPair = ECPairFactory(tinysecp);

function parseArgs( argv ) {
    var result = {};
    for ( var i = 0; i < argv.length; i++ ) {
        if ( argv[i].startsWith( "--" ) ) {
            var key = argv[i].slice( 2 );
            var next = argv[i + 1];
            if ( next === undefined || next.startsWith( "--" ) ) {
                result[ key ] = true; // flag with no value, e.g. --broadcast
            } else {
                result[ key ] = next;
                i = i + 1;
            }
        }
    }
    return result;
}

var args = parseArgs( process.argv.slice(2) );

if ( !process.env.SELLER_PRIV_KEY ) {
    console.log( "Error: SELLER_PRIV_KEY environment variable is required (same key this seller.js instance runs with)." );
    process.exit(1);
}
if ( !args[ "refund-pubkey" ] ) {
    console.log( "Error: --refund-pubkey <hex> is required (the offer's own published \"pubkey\" field for the deal you're recovering)." );
    process.exit(1);
}

var networkName = args.network === "mainnet" ? "mainnet" : "testnet";
var network = evrmorejs.networks[ networkName === "testnet" ? "evrmoreTestnet" : "evrmore" ];
var evrRpcBase = `https://evr-rpc-${networkName}.evrmorecoin.org`;

var sellerPrivKeyRaw = process.env.SELLER_PRIV_KEY.trim();
var sellerKeyPair;
if ( /^[0-9a-fA-F]{64}$/.test( sellerPrivKeyRaw ) ) {
    sellerKeyPair = ECPair.fromPrivateKey( Buffer.from( sellerPrivKeyRaw, "hex" ), { network: network } );
} else if ( sellerPrivKeyRaw.length === 52 ) {
    sellerKeyPair = ECPair.fromWIF( sellerPrivKeyRaw, network );
} else {
    console.log( "Error: SELLER_PRIV_KEY must be 64 hex characters or a 52-character Evrmore compressed WIF key." );
    process.exit(1);
}

// identical derivation to seller.js's own deriveRefundPrivkeyHex() -- must
// be kept in sync with that function if it ever changes
function deriveRefundPrivkeyHex( counter ) {
    return crypto.createHmac( "sha256", Buffer.from( sellerKeyPair.privateKey ) )
        .update( "refund:" + counter )
        .digest( "hex" );
}

var targetPubkey = args[ "refund-pubkey" ].toLowerCase();
var maxCounter = Number( args[ "max-counter" ] ) || 100000;

console.log( "Searching counters 0.." + maxCounter + " for refund_pubkey " + targetPubkey + " (network: " + networkName + ")..." );
var foundCounter = null;
var foundPrivkeyHex = null;
for ( var counter = 0; counter <= maxCounter; counter++ ) {
    var privkeyHex = deriveRefundPrivkeyHex( counter );
    var candidateKeypair;
    try {
        candidateKeypair = ECPair.fromPrivateKey( Buffer.from( privkeyHex, "hex" ), { network: network } );
    } catch ( e ) {
        continue; // same astronomically-unlikely invalid-scalar case seller.js's own getRefundPubkey() guards against
    }
    var candidatePubkey = Buffer.from( candidateKeypair.publicKey ).toString( "hex" );
    if ( candidatePubkey === targetPubkey ) {
        foundCounter = counter;
        foundPrivkeyHex = privkeyHex;
        break;
    }
}

if ( foundCounter === null ) {
    console.log( "Not found in counters 0.." + maxCounter + ". If this seller instance has issued more offers than that, retry with a larger --max-counter." );
    process.exit(1);
}

console.log( "Found: counter " + foundCounter + ", refund private key (hex): " + foundPrivkeyHex );

var haveAllRefundParams = args[ "buyer-pubkey" ] && args[ "payment-hash" ] && args.timelock &&
    args[ "funding-txid" ] && args[ "funding-vout" ] !== undefined && args.amount && args[ "to-address" ];
if ( !haveAllRefundParams ) {
    console.log( "\nNo further action taken -- pass --buyer-pubkey/--payment-hash/--timelock/--funding-txid/--funding-vout/--amount/--to-address too if you also want this script to build (and optionally --broadcast) the refund transaction." );
    process.exit(0);
}

// --- everything below only runs if the full HTLC parameter set was given ---

function generateHtlc( serverPubkey, userPubkey, pmthash, timelock ) {
    return evrmorejs.script.fromASM(
        `OP_SIZE ${Buffer.from(evrmorejs.script.number.encode(32)).toString("hex")} OP_EQUALVERIFY OP_SHA256 ${pmthash} OP_EQUAL OP_IF ${userPubkey} OP_ELSE ${Buffer.from(evrmorejs.script.number.encode(timelock)).toString("hex")} OP_CHECKLOCKTIMEVERIFY OP_DROP ${serverPubkey} OP_ENDIF OP_CHECKSIG`
    );
}
function asEvrmoreSigner( keyPair ) {
    return {
        publicKey: Buffer.from( keyPair.publicKey ),
        sign: function( hash ) { return Buffer.from( keyPair.sign( hash ) ); },
    };
}
function evrmoreRpc( method, params ) {
    var url = evrRpcBase + "/rpc/";
    console.log( "EVR RPC -> " + url + " " + method + ":", JSON.stringify( params ) );
    return axios({ method: "post", url: url, data: { jsonrpc: "2.0", id: 1.0, method: method, params: params }, auth: { username: "whatever", password: "whatever" } })
        .then( function( response ) {
            console.log( "EVR RPC <- " + url + " " + method + " SUCCESS:", JSON.stringify( response.data ) );
            return response.data;
        })
        .catch( function( error ) {
            console.log( "EVR RPC <- " + url + " " + method + " FAILED:", error.message );
            return ( error.response && error.response.data ) || { error: error.message };
        });
}

async function main() {
    var refundKeypair = ECPair.fromPrivateKey( Buffer.from( foundPrivkeyHex, "hex" ), { network: network } );
    var witnessScript = generateHtlc( targetPubkey, args[ "buyer-pubkey" ], args[ "payment-hash" ], Number( args.timelock ) );

    var rawPrevTxReply = await evrmoreRpc( "getrawtransaction", [ args[ "funding-txid" ] ] );
    if ( !rawPrevTxReply || !rawPrevTxReply.result ) {
        console.log( "Could not fetch the funding transaction (" + args[ "funding-txid" ] + ") -- is it still available via " + evrRpcBase + "? Aborting." );
        process.exit(1);
    }

    var psbt = new evrmorejs.Psbt({ network: network })
        .addInput({
            hash: args[ "funding-txid" ],
            index: Number( args[ "funding-vout" ] ),
            sequence: 0xfffffffe,
            nonWitnessUtxo: Buffer.from( rawPrevTxReply.result, "hex" ),
            redeemScript: Buffer.from( witnessScript ),
        })
        .addOutput({
            address: args[ "to-address" ],
            value: Number( args.amount ),
        });
    psbt.setMaximumFeeRate( 50000 );
    psbt.setLocktime( Number( args.timelock ) );
    psbt.signInput( 0, asEvrmoreSigner( refundKeypair ) );

    // byte-for-byte the same as seller.js's own recoverSats()/getFinalScripts
    // -- do not add or remove elements from the compiled input script here
    var getFinalScripts = function( txindex, input, script ) {
        var decompiled = evrmorejs.script.decompile( script );
        if ( !decompiled || decompiled[0] !== evrmorejs.opcodes.OP_SIZE ) {
            throw new Error( "Can not finalize input #" + txindex );
        }
        // any 32-byte value that isn't the real preimage takes the OP_ELSE
        // (refund) branch -- OP_SIZE/OP_EQUALVERIFY require exactly 32
        // bytes, then OP_SHA256/OP_EQUAL must fail to match the payment
        // hash, which a random 32-byte value reliably does
        var p2sh = evrmorejs.payments.p2sh({
            redeem: {
                output: script,
                input: evrmorejs.script.compile([
                    input.partialSig[0].signature,
                    Buffer.from( ECPair.makeRandom().privateKey ),
                ]),
            },
        });
        return { finalScriptSig: p2sh.input };
    };
    psbt.finalizeInput( 0, getFinalScripts );
    var rawtx = psbt.extractTransaction().toHex();

    console.log( "\nSigned refund transaction (hex):\n" + rawtx );

    if ( args.broadcast ) {
        console.log( "\n--broadcast given -- sending it now..." );
        var broadcastReply = await evrmoreRpc( "sendrawtransaction", [ rawtx ] );
        if ( broadcastReply && broadcastReply.result ) {
            console.log( "\nBroadcast succeeded, txid:", broadcastReply.result );
        } else {
            console.log( "\nBroadcast failed -- see the RPC response above. The signed hex above is still valid; you can broadcast it another way if needed." );
        }
    } else {
        console.log( "\n(--broadcast not given -- nothing was sent. Re-run with --broadcast once you've verified the transaction above, or broadcast the hex yourself.)" );
    }
}

main().catch( function( e ) {
    console.log( "Error:", e.message );
    process.exit(1);
});
