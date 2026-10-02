// version=03d5f02e
// Copyright (c) 2026 Hans Schmidt - All rights reserved
const ws = require("websocket");

const WebSocketClient = ws.client;

const browserifyCipher = require("browserify-cipher");

const nobleSecp256k1 = require("noble-secp256k1");

const {chacha20: chacha20} = require("@noble/ciphers/chacha");

const {extract: hkdfExtract, expand: hkdfExpand} = require("@noble/hashes/hkdf");

const {hmac: hmac} = require("@noble/hashes/hmac");

const {sha256: nobleSha256} = require("@noble/hashes/sha256");

const {equalBytes: equalBytes} = require("@noble/ciphers/utils");

const readline = require("readline");

const axios = require("axios");

const evrmorejs = require("evrmorejs-lib");

const request = require("request");

const {ECPairFactory: ECPairFactory} = require("ecpair");

const tinysecp = require("tiny-secp256k1");

const ECPair = ECPairFactory(tinysecp);

const fs = require("fs");

const crypto = require("crypto");

const _originalConsoleLog = console.log;

console.log = function(...args) {
    _originalConsoleLog(`[${(new Date).toISOString()}]`, ...args);
};

function parseConfFile(text) {
    var result = {};
    var lines = text.split("\n");
    var i;
    for (i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line === "" || line[0] === "#") continue;
        var eqIndex = line.indexOf("=");
        if (eqIndex === -1) continue;
        var key = line.slice(0, eqIndex).trim();
        var value = line.slice(eqIndex + 1).trim();
        if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') value = value.slice(1, -1);
        if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
        result[key] = value;
    }
    return result;
}

const configFile = process.argv[2] || "seller.config";

if (!fs.existsSync(configFile)) process.exit(1);

const config = parseConfFile(fs.readFileSync(configFile, "utf8"));

function resolveMacaroon(value) {
    if (fs.existsSync(value)) return fs.readFileSync(value).toString("hex");
    return value;
}

if (!config.sellermac) {
    config.invoicemac;
    process.exit(1);
}

var sellermac = resolveMacaroon(config.sellermac);

var lndendpoint = config.lndendpoint;

var min_amount = config.min_amount;

var max_amount = config.max_amount;

var asset_name = config.asset_name || "";

var asset_min_amount = config.asset_min_amount ? Number(config.asset_min_amount) : void 0;

var asset_max_amount = config.asset_max_amount ? Number(config.asset_max_amount) : void 0;

var asset_evr_bundle_amount = config.asset_evr_bundle_amount ? Number(config.asset_evr_bundle_amount) : void 0;

var swapserviceKeysList = (config.swapservice_keys || "").split(",").map(function(s) {
    return s.trim();
}).filter(Boolean);

var maxPairedSwapservices = Number(config.max_paired_swapservices) || 3;

var maxAggregateExposureSats = Number(config.max_aggregate_exposure_evr) * 1e8;

var network = evrmorejs.networks[config.network === "testnet" ? "evrmoreTestnet" : "evrmore"];

var evrRpcPrefix = config.network === "testnet" ? "testnet" : "mainnet";

var evrRpcBase = `https://evr-rpc-${evrRpcPrefix}.evrmorecoin.org`;

var coordinatorAdKind = config.network === "testnet" ? 10046 : 10047;

var rpcKind = config.network === "testnet" ? 20044 : 20045;

var dmKind = config.network === "testnet" ? 4044 : 4045;

var SELLER_PROTOCOL_VERSION = 1;

if (!process.env.SELLER_PRIV_KEY) process.exit(1);

var sellerPrivKeyRaw = process.env.SELLER_PRIV_KEY.trim();

var sellerKeyPair;

if (/^[0-9a-fA-F]{64}$/.test(sellerPrivKeyRaw)) sellerKeyPair = ECPair.fromPrivateKey(Buffer.from(sellerPrivKeyRaw, "hex"), {
    network: network
}); else if (sellerPrivKeyRaw.length === 52) try {
    sellerKeyPair = ECPair.fromWIF(sellerPrivKeyRaw, network);
} catch (e) {
    e.message;
    process.exit(1);
} else {
    sellerPrivKeyRaw.length;
    process.exit(1);
}

var sellerAddress = evrmorejs.payments.p2pkh({
    pubkey: Buffer.from(sellerKeyPair.publicKey),
    network: network
}).address;

var ACTIVE_ADDRESSES_FILE = "active-seller-addresses.txt";

function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code !== "ESRCH";
    }
}

function readLiveClaims() {
    if (!fs.existsSync(ACTIVE_ADDRESSES_FILE)) return [];
    var lines = fs.readFileSync(ACTIVE_ADDRESSES_FILE, "utf8").split("\n").map(function(line) {
        return line.trim();
    }).filter(function(line) {
        return line !== "";
    });
    var claims = lines.map(function(line) {
        var parts = line.split(" ");
        return {
            address: parts[0],
            pid: Number(parts[1])
        };
    });
    return claims.filter(function(c) {
        return c.pid && isPidAlive(c.pid);
    });
}

function writeClaims(claims) {
    var lines = claims.map(function(c) {
        return c.address + " " + c.pid;
    });
    fs.writeFileSync(ACTIVE_ADDRESSES_FILE, lines.length ? lines.join("\n") + "\n" : "");
}

var liveClaims = readLiveClaims();

if (liveClaims.some(function(c) {
    return c.address === sellerAddress;
})) process.exit(1);

writeClaims(liveClaims.concat([ {
    address: sellerAddress,
    pid: process.pid
} ]));

function releaseAddressClaim() {
    try {
        writeClaims(readLiveClaims().filter(function(c) {
            return !(c.address === sellerAddress && c.pid === process.pid);
        }));
    } catch (e) {}
}

process.on("exit", releaseAddressClaim);

process.on("SIGINT", function() {
    process.exit();
});

process.on("SIGTERM", function() {
    process.exit();
});

process.on("unhandledRejection", function(reason) {
    reason && reason.stack;
});

if (!process.env.EVR_PER_BTC) process.exit(1);

var rate_evr_per_btc = Number(process.env.EVR_PER_BTC);

if (!(rate_evr_per_btc > 0)) {
    process.env.EVR_PER_BTC;
    process.exit(1);
}

var ASSET_NAME_CHARSET = /^[A-Za-z0-9@$%&*(){}\[\].?:#!_-]+$/;

var rate_asset_per_btc;

if (asset_name) {
    if (!ASSET_NAME_CHARSET.test(asset_name)) process.exit(1);
    if (!process.env.ASSET_PER_BTC) process.exit(1);
    rate_asset_per_btc = Number(process.env.ASSET_PER_BTC);
    if (!(rate_asset_per_btc > 0)) {
        process.env.ASSET_PER_BTC;
        process.exit(1);
    }
    if (!(asset_min_amount >= 1) || !(asset_min_amount <= 21e9) || !(asset_max_amount >= 1) || !(asset_max_amount <= 21e9) || !(asset_max_amount >= asset_min_amount)) process.exit(1);
    if (!(asset_evr_bundle_amount > 0)) process.exit(1);
}

function asEvrmoreSigner(keyPair) {
    return {
        publicKey: Buffer.from(keyPair.publicKey),
        sign: function(hash) {
            return Buffer.from(keyPair.sign(hash));
        }
    };
}

function postData(url, json, headers) {
    var options = Object.assign({
        method: "post",
        url: url,
        data: json
    }, headers || {});
    return axios(options).then(function(response) {
        return response.data;
    }).catch(function(error) {
        error.message;
        return error.response && error.response.data || {
            error: error.message
        };
    });
}

function evrmoreRpc(method, params, quiet) {
    var url = `${evrRpcBase}/rpc/`;
    var body = {
        jsonrpc: "2.0",
        id: 1,
        method: method,
        params: params
    };
    var options = {
        auth: {
            username: "whatever",
            password: "whatever"
        }
    };
    if (!quiet) JSON.stringify(params);
    return postData(url, body, options).then(function(reply) {
        var failed = reply && reply.error;
        if (!quiet || failed) if (failed) JSON.stringify(reply); else JSON.stringify(reply);
        return reply;
    });
}

function rpcNodeError(reply) {
    var e = reply && reply.error;
    if (e && typeof e === "object" && e.error && typeof e.error.code === "number") return e.error;
    if (e && typeof e === "object" && typeof e.code === "number") return e;
    return null;
}

async function rpcAnswer(method, params, quiet) {
    var delaySeconds = 5;
    while (true) {
        var reply = await evrmoreRpc(method, params, quiet);
        var nodeError = rpcNodeError(reply);
        if (nodeError) return {
            error: nodeError
        };
        if (reply && !reply.error && reply.result !== void 0) return {
            result: reply.result
        };
        await new Promise(function(resolve) {
            setTimeout(resolve, delaySeconds * 1e3);
        });
        delaySeconds = Math.min(delaySeconds * 2, 60);
    }
}

async function rpcResult(method, params, quiet) {
    var answer = await rpcAnswer(method, params, quiet);
    if (answer.error) throw new Error("EVR RPC " + method + " failed: " + answer.error.message);
    return answer.result;
}

async function getMinFeeRate() {
    var reply = await evrmoreRpc("estimatesmartfee", [ 1, "CONSERVATIVE" ]);
    if (!reply || !reply.result || !("feerate" in reply.result)) {
        JSON.stringify(reply);
        return 5e3;
    }
    var feerate_evr_per_kb = reply.result["feerate"];
    var feerate_per_byte = Math.ceil(feerate_evr_per_kb * 1e8 / 1e3);
    return feerate_per_byte;
}

async function getBlockheight() {
    return Number(await rpcResult("getblockcount", []));
}

async function getRawTxHex(txid) {
    return await rpcResult("getrawtransaction", [ txid ]);
}

function generateHtlc(serverPubkey, userPubkey, pmthash, timelock) {
    return evrmorejs.script.fromASM(`\n        OP_SIZE\n        ${Buffer.from(evrmorejs.script.number.encode(32)).toString("hex")}\n        OP_EQUALVERIFY\n        OP_SHA256\n        ${pmthash}\n        OP_EQUAL\n        OP_IF\n        ${userPubkey}\n        OP_ELSE\n        ${Buffer.from(evrmorejs.script.number.encode(timelock)).toString("hex")}\n        OP_CHECKLOCKTIMEVERIFY\n        OP_DROP\n        ${serverPubkey}\n        OP_ENDIF\n        OP_CHECKSIG\n        `.trim().replace(/\s+/g, " "));
}

function getSwapAddress(serverPubkey, userPubkey, pmthash, timelock) {
    var witnessscript = generateHtlc(serverPubkey, userPubkey, pmthash, timelock);
    var p2sh = evrmorejs.payments.p2sh({
        redeem: {
            output: witnessscript,
            network: network
        },
        network: network
    });
    return p2sh.address;
}

var DUST_THRESHOLD = 3e3;

function outputHasAssetTail(scriptBuffer) {
    var decompiled = evrmorejs.script.decompile(scriptBuffer);
    return !!decompiled && decompiled.indexOf(evrmorejs.opcodes.OP_EVR_ASSET) !== -1;
}

var ASSET_TAIL_MAX_BYTES = 75;

async function selectFundingUtxos(amount, assetName, assetAmount) {
    var utxoReply = await evrmoreRpc("getaddressutxos", [ {
        addresses: [ sellerAddress ]
    } ]);
    var rawUtxos = utxoReply.result || [];
    if (assetName) {
        var assetUtxoReply = await evrmoreRpc("getaddressutxos", [ {
            addresses: [ sellerAddress ],
            assetName: assetName
        } ]);
        rawUtxos = rawUtxos.concat(assetUtxoReply.result || []);
    }
    var feerate = await getMinFeeRate();
    var reserved = reservedOutpoints();
    rawUtxos = rawUtxos.filter(function(u) {
        var tx_hash = u.tx_hash || u.txid;
        var tx_pos = u.tx_pos !== void 0 ? u.tx_pos : u.outputIndex;
        return !reserved.has(tx_hash + ":" + tx_pos);
    });
    var utxos = rawUtxos.map(function(u) {
        return {
            tx_hash: u.tx_hash || u.txid,
            tx_pos: u.tx_pos !== void 0 ? u.tx_pos : u.outputIndex,
            value: u.value !== void 0 ? u.value : u.satoshis,
            asset: u.assetName === "EVR" || !u.assetName ? "None" : u.assetName
        };
    });
    var assetSelected = [], totalInAsset;
    if (assetName) {
        assetSelected = evrmorejs.selectUtxos(utxos, [ {
            asset: assetName,
            amount: Number(assetAmount)
        } ], 0).filter(function(u) {
            return u.asset === assetName;
        });
        totalInAsset = 0;
        var a;
        for (a = 0; a < assetSelected.length; a++) totalInAsset += Number(assetSelected[a].value);
    }
    var assetOutputCount = assetName ? totalInAsset > Number(assetAmount) ? 2 : 1 : 0;
    var selected, fee, totalIn;
    var target = Number(amount);
    var pass;
    for (pass = 0; pass < 6; pass++) {
        selected = evrmorejs.selectUtxos(utxos, [ {
            asset: "EVR",
            amount: target
        } ], DUST_THRESHOLD);
        var estimatedTxSize = selected.length * 148 + assetSelected.length * 148 + 2 * 34 + assetOutputCount * (34 + ASSET_TAIL_MAX_BYTES) + 10;
        fee = estimatedTxSize * Number(feerate);
        totalIn = 0;
        var u;
        for (u = 0; u < selected.length; u++) totalIn += Number(selected[u].value);
        if (totalIn >= Number(amount) + fee) break;
        target = Number(amount) + fee;
    }
    if (totalIn < Number(amount) + fee) throw new Error("Insufficient UTXOs to cover amount (" + amount + ") plus estimated fee (" + fee + "); have " + totalIn);
    selected = selected.concat(assetSelected);
    return {
        selected: selected,
        feerate: feerate,
        fee: fee,
        totalIn: totalIn,
        totalInAsset: totalInAsset
    };
}

async function hasSufficientBalance(req) {
    try {
        if (maxAggregateExposureSats && currentAggregateExposure() + exposureValueEvrSats(req.amount, req.asset_name, req.asset_amount) > maxAggregateExposureSats) return {
            sufficient: false,
            reason: "this request would push aggregate in-flight exposure over max_aggregate_exposure_evr (" + maxAggregateExposureSats / 1e8 + " EVR)"
        };
        await selectFundingUtxos(req.amount, req.asset_name, req.asset_amount);
        return {
            sufficient: true
        };
    } catch (e) {
        return {
            sufficient: false,
            reason: e.message
        };
    }
}

var LEASE_TTL_MS = 3 * 60 * 1e3;

var SIGNED_GRACE_WINDOW_MS = config.signed_grace_window_ms || 30 * 60 * 1e3;

var leases = new Map;

var LEASE_STATE_FILE = config.lease_state_file || "seller-lease-state.json";

function persistState() {
    try {
        var data = JSON.stringify({
            refundKeyCounter: refundKeyCounter,
            refundKeys: Array.from(refundKeys.entries()),
            leases: Array.from(leases.entries())
        });
        var tmpPath = LEASE_STATE_FILE + ".tmp";
        fs.writeFileSync(tmpPath, data);
        fs.renameSync(tmpPath, LEASE_STATE_FILE);
    } catch (e) {
        e.message;
    }
}

function loadPersistedState() {
    if (!fs.existsSync(LEASE_STATE_FILE)) return;
    try {
        var data = JSON.parse(fs.readFileSync(LEASE_STATE_FILE, "utf8"));
        refundKeyCounter = data.refundKeyCounter || 0;
        refundKeys.clear();
        (data.refundKeys || []).forEach(function(entry) {
            refundKeys.set(entry[0], entry[1]);
        });
        leases.clear();
        (data.leases || []).forEach(function(entry) {
            leases.set(entry[0], entry[1]);
        });
        refundKeys.size, leases.size;
    } catch (e) {
        e.message;
    }
}

var refundKeys = new Map;

var refundKeyCounter = 0;

function deriveRefundPrivkeyHex(counter) {
    return crypto.createHmac("sha256", Buffer.from(sellerKeyPair.privateKey)).update("refund:" + counter).digest("hex");
}

var REFUND_KEY_TTL_MS = 24 * 60 * 60 * 1e3;

function refundPubkeyStillInUse(pubkeyHex) {
    for (var [, lease] of leases) if (lease.refund_pubkey === pubkeyHex) return true;
    return false;
}

async function getRefundPubkey() {
    var now = Date.now();
    for (var [pubkeyHex, entry] of refundKeys) if (now - entry.created_at > REFUND_KEY_TTL_MS && !refundPubkeyStillInUse(pubkeyHex)) refundKeys.delete(pubkeyHex);
    var counter = refundKeyCounter;
    var pubkeyHex;
    while (true) try {
        var privkeyHex = deriveRefundPrivkeyHex(counter);
        var keypair = ECPair.fromPrivateKey(Buffer.from(privkeyHex, "hex"), {
            network: network
        });
        pubkeyHex = Buffer.from(keypair.publicKey).toString("hex");
        break;
    } catch (e) {
        e.message;
        counter += 1;
    }
    refundKeys.set(pubkeyHex, {
        counter: counter,
        created_at: now
    });
    refundKeyCounter = counter + 1;
    persistState();
    return {
        refund_pubkey: pubkeyHex
    };
}

var haltedDueToInconsistency = false;

function getActiveLease(lease_id) {
    var lease = leases.get(lease_id);
    if (!lease) return null;
    if (lease.state === "leased" && Date.now() > lease.expires_at) {
        leases.delete(lease_id);
        return null;
    }
    return lease;
}

function reservedOutpoints() {
    var reserved = new Set;
    for (var [lease_id, lease] of leases) {
        if (lease.state === "leased" && Date.now() > lease.expires_at) continue;
        lease.utxos.forEach(function(u) {
            reserved.add(u.tx_hash + ":" + u.vout);
        });
    }
    return reserved;
}

function exposureValueEvrSats(amount, assetName, assetAmount) {
    var total = Number(amount);
    if (assetName && rate_asset_per_btc) total += Number(assetAmount) * rate_evr_per_btc / rate_asset_per_btc;
    return total;
}

function currentAggregateExposure() {
    var total = 0;
    for (var [, lease] of leases) if (lease.state === "leased" || lease.state === "signed" || lease.state === "funded") total += exposureValueEvrSats(lease.amount, lease.asset_name, lease.asset_amount);
    return total;
}

var lastUtxoSnapshot = null;

async function currentSellerUtxoSnapshot() {
    var raw = await rpcResult("getaddressutxos", [ {
        addresses: [ sellerAddress ]
    } ], true) || [];
    raw = raw.concat(await rpcResult("getaddressutxos", [ {
        addresses: [ sellerAddress ],
        assetName: "*"
    } ], true) || []);
    var snapshot = new Set;
    raw.forEach(function(u) {
        var tx_hash = u.tx_hash || u.txid;
        var tx_pos = u.tx_pos !== void 0 ? u.tx_pos : u.outputIndex;
        snapshot.add(tx_hash + ":" + tx_pos);
    });
    return snapshot;
}

async function reconcileLeases() {
    var currentSnapshot = await currentSellerUtxoSnapshot();
    if (lastUtxoSnapshot) {
        var newlySpent = [];
        lastUtxoSnapshot.forEach(function(outpoint) {
            if (!currentSnapshot.has(outpoint)) newlySpent.push(outpoint);
        });
        newlySpent.forEach(function(outpoint) {
            var matchedLeaseId = null;
            for (var [lease_id, lease] of leases) if ((lease.state === "signed" || lease.state === "funded") && lease.utxos.some(function(u) {
                return u.tx_hash + ":" + u.vout === outpoint;
            })) {
                matchedLeaseId = lease_id;
                break;
            }
            if (matchedLeaseId) {
                var matchedLease = leases.get(matchedLeaseId);
                if (matchedLease.state === "signed") {
                    matchedLease.state = "funded";
                    matchedLease.funded_at = Date.now();
                }
            } else haltedDueToInconsistency = true;
        });
    }
    lastUtxoSnapshot = currentSnapshot;
    var now = Date.now();
    for (var [lease_id, lease] of leases) if (lease.state === "signed" && now - lease.signed_at > SIGNED_GRACE_WINDOW_MS) {
        var stillUnspent = lease.utxos.every(function(u) {
            return currentSnapshot.has(u.tx_hash + ":" + u.vout);
        });
        if (stillUnspent) leases.delete(lease_id);
    } else if (lease.state === "leased" && now > lease.expires_at) leases.delete(lease_id);
    persistState();
}

var RECONCILE_INTERVAL_MS = 2 * 60 * 1e3;

var reconcileInFlight = false;

function startReconciliationLoop() {
    currentSellerUtxoSnapshot().then(function(snapshot) {
        lastUtxoSnapshot = snapshot;
    }).catch(function(e) {
        e.message;
    });
    setInterval(function() {
        if (reconcileInFlight) return;
        reconcileInFlight = true;
        reconcileLeases().catch(function(e) {
            e.message;
        }).then(function() {
            reconcileInFlight = false;
        });
    }, RECONCILE_INTERVAL_MS);
}

var LEASE_TIMELOCK_MIN_BLOCKS = 60;

var LEASE_TIMELOCK_MAX_BLOCKS = 130;

var MIN_COMPENSATION_INVOICE_CLTV = 40;

var COMPENSATION_ROUNDING_TOLERANCE_LSATS = 2;

function expectedCompensationLsats(lease) {
    if (lease.asset_name) return Math.round(lease.asset_amount / 1e8 / rate_asset_per_btc * 1e8) + Math.round(lease.amount / 1e8 / rate_evr_per_btc * 1e8);
    return Math.round(lease.amount / 1e8 / rate_evr_per_btc * 1e8);
}

async function leaseUtxos(req) {
    if (haltedDueToInconsistency) return {
        error: "seller.js has halted signing due to a detected on-chain inconsistency -- see logs, restart required"
    };
    if (!refundKeys.has(req.refund_pubkey)) return {
        error: "unrecognized refund_pubkey -- must be one this seller previously issued via get_refund_pubkey"
    };
    if ((req.asset_name || "") !== asset_name) return {
        error: "this seller only sells " + (asset_name || "EVR") + ", not " + (req.asset_name || "EVR")
    };
    if (asset_name && Number(req.amount) !== Math.round(asset_evr_bundle_amount * 1e8)) return {
        error: "EVR bundle amount " + req.amount + " doesn't match this seller's asset_evr_bundle_amount (" + asset_evr_bundle_amount + " EVR)"
    };
    if (!Number.isInteger(req.timelock)) return {
        error: "timelock must be an integer block height"
    };
    var leaseHeight = await getBlockheight();
    if (req.timelock < leaseHeight + LEASE_TIMELOCK_MIN_BLOCKS || req.timelock > leaseHeight + LEASE_TIMELOCK_MAX_BLOCKS) return {
        error: "timelock " + req.timelock + " must be " + LEASE_TIMELOCK_MIN_BLOCKS + " to " + LEASE_TIMELOCK_MAX_BLOCKS + " blocks ahead of the current height (" + leaseHeight + ")"
    };
    if (!req.asset_name) {
        var amountEvr = Number(req.amount) / 1e8;
        if (!(amountEvr >= Number(min_amount)) || !(amountEvr <= Number(max_amount))) return {
            error: "amount " + amountEvr + " EVR is outside this seller's [" + min_amount + ", " + max_amount + "] EVR range"
        };
    } else {
        var assetAmountHuman = Number(req.asset_amount) / 1e8;
        if (!(assetAmountHuman >= asset_min_amount) || !(assetAmountHuman <= asset_max_amount)) return {
            error: "asset amount " + assetAmountHuman + " " + req.asset_name + " is outside this seller's [" + asset_min_amount + ", " + asset_max_amount + "] configured range"
        };
    }
    if (maxAggregateExposureSats && currentAggregateExposure() + exposureValueEvrSats(req.amount, req.asset_name, req.asset_amount) > maxAggregateExposureSats) return {
        error: "this request would push aggregate in-flight exposure over max_aggregate_exposure_evr (" + maxAggregateExposureSats / 1e8 + " EVR) -- try again once an existing deal concludes"
    };
    var verified_htlc_address;
    try {
        verified_htlc_address = getSwapAddress(req.refund_pubkey, req.buyer_pubkey, req.payment_hash, req.timelock);
    } catch (e) {
        return {
            error: "failed to derive HTLC address from supplied parameters: " + e.message
        };
    }
    var funding;
    try {
        funding = await selectFundingUtxos(req.amount, req.asset_name, req.asset_amount);
    } catch (e) {
        return {
            error: e.message
        };
    }
    var lease_id = crypto.randomBytes(16).toString("hex");
    leases.set(lease_id, {
        utxos: funding.selected,
        verified_htlc_address: verified_htlc_address,
        payment_hash: req.payment_hash,
        timelock: req.timelock,
        buyer_pubkey: req.buyer_pubkey,
        refund_pubkey: req.refund_pubkey,
        refund_key_counter: refundKeys.get(req.refund_pubkey).counter,
        amount: Number(req.amount),
        fee: funding.fee,
        totalIn: funding.totalIn,
        asset_name: req.asset_name,
        asset_amount: req.asset_name ? Number(req.asset_amount) : void 0,
        totalInAsset: funding.totalInAsset,
        change_address: sellerAddress,
        expires_at: Date.now() + LEASE_TTL_MS,
        state: "leased"
    });
    persistState();
    return {
        lease_id: lease_id,
        expires_at: Date.now() + LEASE_TTL_MS,
        utxos: funding.selected.map(function(u) {
            return {
                tx_hash: u.tx_hash,
                vout: u.vout,
                value: u.value,
                asset: u.asset
            };
        }),
        change_address: sellerAddress,
        fee: funding.fee,
        asset_name: req.asset_name,
        asset_amount: req.asset_name ? Number(req.asset_amount) : void 0,
        total_in_asset: funding.totalInAsset
    };
}

async function signPsbt(req) {
    if (haltedDueToInconsistency) return {
        error: "seller.js has halted signing due to a detected on-chain inconsistency -- see logs, restart required"
    };
    var lease = getActiveLease(req.lease_id);
    if (!lease) return {
        error: "no active lease with id " + req.lease_id
    };
    if (lease.state !== "leased") return {
        error: "lease " + req.lease_id + " is not in a signable state (state: " + lease.state + ")"
    };
    if (!lease.holdInvoiceAmount) return {
        error: "compensation invoice not yet requested for this lease",
        code: "compensation_not_held"
    };
    var compensationStatus = await checkOwnInvoiceStatus(lease.payment_hash);
    if (compensationStatus !== "ACCEPTED") return {
        error: "compensation invoice not yet held (status: " + compensationStatus + ")",
        code: "compensation_not_held"
    };
    if (!(lease.holdInvoiceAmount >= expectedCompensationLsats(lease) - COMPENSATION_ROUNDING_TOLERANCE_LSATS)) return {
        error: "the held compensation (" + lease.holdInvoiceAmount + " L-sats) is below this seller's price for the lease"
    };
    var psbt;
    try {
        psbt = evrmorejs.Psbt.fromBase64(req.psbt_base64, {
            network: network
        });
    } catch (e) {
        return {
            error: "failed to parse PSBT: " + e.message
        };
    }
    var txInputs = psbt.txInputs;
    if (txInputs.length !== lease.utxos.length) return {
        error: "PSBT has " + txInputs.length + " input(s), expected " + lease.utxos.length
    };
    var remaining = lease.utxos.slice();
    var i;
    for (i = 0; i < txInputs.length; i++) {
        var inputTxid = Buffer.from(txInputs[i].hash).reverse().toString("hex");
        var inputVout = txInputs[i].index;
        var matchIndex = remaining.findIndex(function(u) {
            return u.tx_hash === inputTxid && Number(u.vout) === Number(inputVout);
        });
        if (matchIndex === -1) return {
            error: "PSBT input " + i + " (" + inputTxid + ":" + inputVout + ") is not part of this lease"
        };
        remaining.splice(matchIndex, 1);
    }
    var outputs = psbt.txOutputs;
    var expectedChange = lease.totalIn - lease.amount - lease.fee;
    if (lease.asset_name) {
        var htlcCandidates = outputs.filter(function(o) {
            return o.address === lease.verified_htlc_address;
        });
        var assetHtlcOuts = htlcCandidates.filter(function(o) {
            return outputHasAssetTail(o.script);
        });
        var evrHtlcOuts = htlcCandidates.filter(function(o) {
            return !outputHasAssetTail(o.script);
        });
        if (assetHtlcOuts.length !== 1 || Number(assetHtlcOuts[0].value) !== 0) return {
            error: "PSBT does not have exactly one value-0 asset-tagged output at the leased HTLC address " + lease.verified_htlc_address
        };
        var expectedAssetScript = evrmorejs.address.toOutputScript(lease.verified_htlc_address, network, {
            name: lease.asset_name,
            amount: lease.asset_amount
        });
        if (!Buffer.from(assetHtlcOuts[0].script).equals(expectedAssetScript)) return {
            error: "PSBT's asset-tagged HTLC output does not match the expected asset (" + lease.asset_name + ", " + lease.asset_amount + ")"
        };
        if (evrHtlcOuts.length !== 1 || Number(evrHtlcOuts[0].value) !== lease.amount) return {
            error: "PSBT does not pay exactly " + lease.amount + " to the leased HTLC address's plain EVR leg"
        };
        var otherOutputs = outputs.filter(function(o) {
            return o.address !== lease.verified_htlc_address;
        });
        var assetChangeOuts = otherOutputs.filter(function(o) {
            return outputHasAssetTail(o.script);
        });
        var evrChangeOuts = otherOutputs.filter(function(o) {
            return !outputHasAssetTail(o.script);
        });
        if (assetChangeOuts.length > 1 || evrChangeOuts.length > 1) return {
            error: "PSBT has unexpected extra outputs"
        };
        var expectedAssetChange = lease.totalInAsset - lease.asset_amount;
        if (expectedAssetChange > 0) {
            if (assetChangeOuts.length !== 1) return {
                error: "PSBT is missing the expected asset-change output (" + expectedAssetChange + " " + lease.asset_name + ")"
            };
            if (assetChangeOuts[0].address !== sellerAddress) return {
                error: "PSBT's asset-change output does not pay this seller's own address"
            };
            var expectedAssetChangeScript = evrmorejs.address.toOutputScript(sellerAddress, network, {
                name: lease.asset_name,
                amount: expectedAssetChange
            });
            if (Number(assetChangeOuts[0].value) !== 0 || !Buffer.from(assetChangeOuts[0].script).equals(expectedAssetChangeScript)) return {
                error: "PSBT's asset-change output does not match the expected remainder (" + expectedAssetChange + " " + lease.asset_name + ")"
            };
        } else if (assetChangeOuts.length > 0) return {
            error: "PSBT has an unexpected asset-change output"
        };
        if (evrChangeOuts.length === 1) {
            if (evrChangeOuts[0].address !== sellerAddress) return {
                error: "PSBT's change output does not pay this seller's own address"
            };
            if (expectedChange > DUST_THRESHOLD && Number(evrChangeOuts[0].value) !== Math.floor(expectedChange)) return {
                error: "PSBT's change output amount (" + evrChangeOuts[0].value + ") does not match the expected remainder (" + Math.floor(expectedChange) + ")"
            };
        } else if (expectedChange > DUST_THRESHOLD) return {
            error: "PSBT is missing a change output for the expected remainder (" + Math.floor(expectedChange) + ")"
        };
    } else {
        var htlcOutputs = outputs.filter(function(o) {
            return o.address === lease.verified_htlc_address;
        });
        if (htlcOutputs.length !== 1 || Number(htlcOutputs[0].value) !== lease.amount) return {
            error: "PSBT does not pay exactly " + lease.amount + " to the leased HTLC address " + lease.verified_htlc_address
        };
        var otherOutputsEvr = outputs.filter(function(o) {
            return o.address !== lease.verified_htlc_address;
        });
        if (otherOutputsEvr.length > 1) return {
            error: "PSBT has unexpected extra outputs"
        };
        if (otherOutputsEvr.length === 1) {
            var changeOut = otherOutputsEvr[0];
            if (changeOut.address !== sellerAddress) return {
                error: "PSBT's change output does not pay this seller's own address"
            };
            if (expectedChange > DUST_THRESHOLD && Number(changeOut.value) !== Math.floor(expectedChange)) return {
                error: "PSBT's change output amount (" + changeOut.value + ") does not match the expected remainder (" + Math.floor(expectedChange) + ")"
            };
        } else if (expectedChange > DUST_THRESHOLD) return {
            error: "PSBT is missing a change output for the expected remainder (" + Math.floor(expectedChange) + ")"
        };
    }
    var impliedFee = lease.totalIn - outputs.reduce(function(sum, o) {
        return sum + Number(o.value);
    }, 0);
    var freshFeerate = await getMinFeeRate();
    var assetOutputCount = lease.asset_name ? lease.totalInAsset > lease.asset_amount ? 2 : 1 : 0;
    var estimatedTxSize = lease.asset_name ? lease.utxos.length * 148 + 2 * 34 + assetOutputCount * (34 + ASSET_TAIL_MAX_BYTES) + 10 : lease.utxos.length * 148 + 2 * 34 + 10;
    var freshFeeEstimate = estimatedTxSize * freshFeerate;
    if (impliedFee < freshFeeEstimate * .5 || impliedFee > freshFeeEstimate * 3) return {
        error: "PSBT's implied fee (" + impliedFee + ") is outside a sane range of the current estimate (" + freshFeeEstimate + ")"
    };
    var idx;
    for (idx = 0; idx < txInputs.length; idx++) psbt.signInput(idx, asEvrmoreSigner(sellerKeyPair));
    lease.state = "signed";
    lease.signed_at = Date.now();
    persistState();
    watchLease(req.lease_id).catch(function(e) {
        req.lease_id, e.message;
    });
    return {
        psbt_base64: psbt.toBase64()
    };
}

async function getLndNodePubkey() {
    let options = {
        url: lndendpoint + "/v1/getinfo",
        rejectUnauthorized: false,
        json: true,
        timeout: 15e3,
        headers: {
            "Grpc-Metadata-macaroon": sellermac
        }
    };
    return new Promise(function(resolve) {
        request.get(options, function(error, response, body) {
            var pubkey = body && body["identity_pubkey"];
            if (error || !pubkey) {
                error ? error.message : JSON.stringify(body);
                resolve(null);
            } else resolve(pubkey);
        });
    });
}

async function getConfig() {
    var lnd_node_pubkey = await getLndNodePubkey();
    if (!lnd_node_pubkey) return {
        error: "the seller couldn't read its own LND node key"
    };
    if (asset_name) return {
        asset_name: asset_name,
        asset_min_amount: asset_min_amount,
        asset_max_amount: asset_max_amount,
        rate_asset_per_btc: rate_asset_per_btc,
        asset_evr_bundle_amount: asset_evr_bundle_amount,
        rate_evr_per_btc: rate_evr_per_btc,
        lnd_node_pubkey: lnd_node_pubkey
    };
    return {
        min_amount: min_amount,
        max_amount: max_amount,
        rate_evr_per_btc: rate_evr_per_btc,
        lnd_node_pubkey: lnd_node_pubkey
    };
}

function waitSomeSeconds(num) {
    var num = num.toString() + "000";
    num = Number(num);
    return new Promise(function(resolve, reject) {
        setTimeout(resolve, num);
    });
}

async function howManyConfs(txid, quiet) {
    var answer = await rpcAnswer("getrawtransaction", [ txid, true ], quiet);
    if (answer.result && answer.result["confirmations"]) return answer.result["confirmations"];
    return "0".toString();
}

async function waitForOneConfirmation(txid, invoiceState) {
    var tries = 0;
    while (true) {
        var isFirstTick = tries === 0;
        var confs = await howManyConfs(txid, !isFirstTick);
        if (Number(confs) >= 1) {
            if (!isFirstTick) await howManyConfs(txid, false);
            return true;
        }
        tries += 1;
        if (tries >= 30) {
            var state = await invoiceState();
            if (state === "SETTLED") return true;
            if (state === "CANCELED") {
                await howManyConfs(txid, false);
                return false;
            }
            if (tries % 30 === 0) ;
        }
        await waitSomeSeconds(60);
    }
}

async function addressBalanceStatus(address) {
    var result = await rpcResult("getaddressbalance", [ {
        addresses: [ address ]
    } ]);
    var received = !!(result && result["received"] > 0);
    var spent = !!(result && result["balance"] < result["received"]);
    return {
        received: received,
        spent: spent
    };
}

async function getPreimageFromTransactionThatSpendsAnHTLC(txid, pmthash) {
    if (!txid) throw new Error("getPreimageFromTransactionThatSpendsAnHTLC: no transaction id");
    var json = await rpcResult("getrawtransaction", [ txid, true ]);
    var i;
    for (i = 0; i < (json && json["vin"] || []).length; i++) {
        var scriptsig_hex = json["vin"][i]["scriptSig"] && json["vin"][i]["scriptSig"]["hex"];
        if (!scriptsig_hex) continue;
        var decompiled = evrmorejs.script.decompile(Buffer.from(scriptsig_hex, "hex"));
        if (!decompiled) continue;
        var j;
        for (j = 0; j < decompiled.length; j++) {
            if (!Buffer.isBuffer(decompiled[j]) && !(decompiled[j] instanceof Uint8Array)) continue;
            var candidate = Buffer.from(decompiled[j]).toString("hex");
            if (Buffer.from(evrmorejs.crypto.sha256(Buffer.from(candidate, "hex"))).toString("hex") == pmthash) return candidate;
        }
    }
}

async function findHtlcSpend(address, payment_hash, redeemScriptHex) {
    var candidateTxids = (await rpcResult("getaddresstxids", [ {
        addresses: [ address ]
    } ]) || []).map(function(c) {
        return c.transactionid || c;
    });
    var i;
    for (i = 0; i < candidateTxids.length; i++) {
        var tx = await rpcResult("getrawtransaction", [ candidateTxids[i], true ]);
        var spendsHtlc = (tx && tx["vin"] || []).some(function(input) {
            var scriptsig_hex = input["scriptSig"] && input["scriptSig"]["hex"];
            var decompiled = scriptsig_hex && evrmorejs.script.decompile(Buffer.from(scriptsig_hex, "hex"));
            var last = decompiled && decompiled[decompiled.length - 1];
            return !!last && typeof last !== "number" && Buffer.from(last).toString("hex") === redeemScriptHex;
        });
        if (!spendsHtlc) continue;
        var preimage = await getPreimageFromTransactionThatSpendsAnHTLC(candidateTxids[i], payment_hash);
        return {
            txid: candidateTxids[i],
            preimage: preimage || null
        };
    }
    return null;
}

async function broadcastRawTx(rawtx) {
    var txid = evrmorejs.Transaction.fromHex(rawtx).getId();
    var answer = await rpcAnswer("sendrawtransaction", [ rawtx ]);
    if (!answer.error) return answer.result;
    var known = await rpcAnswer("getrawtransaction", [ txid ]);
    if (!known.error) return txid;
    answer.error.message;
    return;
}

async function recoverSats(senderPrivkey, inputtxid, inputindex, fromamount, toaddress, toamount, sequence_number, witnessScriptHex, timelock, assetInput, asset_name, asset_amount) {
    var rawPrevTx = await getRawTxHex(inputtxid);
    var psbt = new evrmorejs.Psbt({
        network: network
    }).addInput({
        hash: inputtxid,
        index: inputindex,
        sequence: Number(sequence_number),
        nonWitnessUtxo: Buffer.from(rawPrevTx, "hex"),
        redeemScript: Buffer.from(witnessScriptHex, "hex")
    }).addOutput({
        address: toaddress,
        value: Number(toamount)
    });
    if (assetInput) {
        var rawAssetPrevTx = await getRawTxHex(assetInput.txid);
        psbt.addInput({
            hash: assetInput.txid,
            index: assetInput.vout,
            sequence: Number(sequence_number),
            nonWitnessUtxo: Buffer.from(rawAssetPrevTx, "hex"),
            redeemScript: Buffer.from(witnessScriptHex, "hex")
        });
        psbt.addOutput({
            address: toaddress,
            value: 0,
            asset: {
                name: asset_name,
                amount: asset_amount
            }
        });
    }
    psbt.setMaximumFeeRate(5e4);
    psbt.setLocktime(Number(timelock));
    var getFinalScripts = (txindex, input, script) => {
        var decompiled = evrmorejs.script.decompile(script);
        if (!decompiled || decompiled[0] !== evrmorejs.opcodes.OP_SIZE) throw new Error(`Can not finalize input #${txindex}`);
        var p2sh = evrmorejs.payments.p2sh({
            redeem: {
                output: script,
                input: evrmorejs.script.compile([ input.partialSig[0].signature, Buffer.from(ECPair.makeRandom().privateKey) ])
            }
        });
        return {
            finalScriptSig: p2sh.input
        };
    };
    var senderKeyPair = ECPair.fromPrivateKey(Buffer.from(senderPrivkey, "hex"));
    psbt.signInput(0, asEvrmoreSigner(senderKeyPair));
    psbt.finalizeInput(0, getFinalScripts);
    if (assetInput) {
        psbt.signInput(1, asEvrmoreSigner(senderKeyPair));
        psbt.finalizeInput(1, getFinalScripts);
    }
    return psbt.extractTransaction().toHex();
}

async function getHodlInvoice(amount, hash, expiry) {
    if (expiry === void 0) expiry = 40;
    var invoice = "";
    var macaroon = sellermac;
    var endpoint = lndendpoint + "/v2/invoices/hodl";
    let requestBody = {
        hash: Buffer.from(hash, "hex").toString("base64"),
        value: amount.toString(),
        cltv_expiry: expiry.toString()
    };
    let options = {
        url: endpoint,
        rejectUnauthorized: false,
        json: true,
        timeout: 15e3,
        headers: {
            "Grpc-Metadata-macaroon": macaroon
        },
        form: JSON.stringify(requestBody)
    };
    JSON.stringify(requestBody);
    request.post(options, function(error, response, body) {
        invoice = body && body["payment_request"];
        if (error) error.message; else JSON.stringify(body);
    });
    var attempts = 0;
    async function isNoteSetYet(note_i_seek) {
        return new Promise(function(resolve, reject) {
            if (note_i_seek == "") {
                attempts += 1;
                if (attempts >= 100) {
                    resolve("");
                    return;
                }
                setTimeout(async function() {
                    var msg = await isNoteSetYet(invoice);
                    resolve(msg);
                }, 100);
            } else resolve(note_i_seek);
        });
    }
    async function getTimeoutData() {
        var invoice_i_seek = await isNoteSetYet(invoice);
        return invoice_i_seek;
    }
    var returnable = await getTimeoutData();
    return returnable;
}

async function checkOwnInvoiceStatus(hash) {
    var status;
    const macaroon = sellermac;
    const endpoint = lndendpoint;
    let options = {
        url: endpoint + "/v1/invoice/" + hash,
        rejectUnauthorized: false,
        json: true,
        timeout: 15e3,
        headers: {
            "Grpc-Metadata-macaroon": macaroon
        }
    };
    return new Promise(function(resolve) {
        request.get(options, function(error, response, body) {
            if (error) error.message; else JSON.stringify(body);
            status = body && body["state"];
            resolve(status);
        });
    });
}

async function settleOwnInvoiceUntilDone(preimage, payment_hash) {
    while (true) {
        await settleHoldInvoice(preimage);
        var state = await checkOwnInvoiceStatus(payment_hash);
        if (state === "SETTLED") return true;
        if (state === "CANCELED") return false;
        await waitSomeSeconds(30);
    }
}

async function settleHoldInvoice(preimage) {
    var settled = "";
    const macaroon = sellermac;
    const endpoint = lndendpoint;
    let requestBody = {
        preimage: Buffer.from(preimage, "hex").toString("base64")
    };
    let options = {
        url: endpoint + "/v2/invoices/settle",
        rejectUnauthorized: false,
        json: true,
        timeout: 15e3,
        headers: {
            "Grpc-Metadata-macaroon": macaroon
        },
        form: JSON.stringify(requestBody)
    };
    JSON.stringify(requestBody);
    request.post(options, function(error, response, body) {
        if (!error && response && response.statusCode === 200) {
            JSON.stringify(body);
            settled = "true";
        } else {
            error && (error.message || error) || body && (body.message || JSON.stringify(body));
            settled = "false";
        }
    });
    async function isNoteSetYet(note_i_seek) {
        return new Promise(function(resolve, reject) {
            if (note_i_seek == "") setTimeout(async function() {
                var msg = await isNoteSetYet(settled);
                resolve(msg);
            }, 100); else resolve(note_i_seek);
        });
    }
    async function getTimeoutData() {
        var invoice_i_seek = await isNoteSetYet(settled);
        return invoice_i_seek;
    }
    var returnable = await getTimeoutData();
    return returnable;
}

var activeWatchers = new Map;

function resolveLease(lease_id, note) {
    leases.delete(lease_id);
    persistState();
}

var TIMELOCK_TRIGGER_BUFFER_BLOCKS = 10;

async function watchLease(lease_id) {
    var lease = leases.get(lease_id);
    if (!lease) return;
    var watcherState = {
        cancelled: false
    };
    activeWatchers.set(lease_id, watcherState);
    var tries = 0;
    while (true) {
        if (watcherState.cancelled) {
            activeWatchers.delete(lease_id);
            return;
        }
        if (!leases.has(lease_id)) {
            activeWatchers.delete(lease_id);
            return;
        }
        try {
            var balanceStatus = await addressBalanceStatus(lease.verified_htlc_address);
            if (balanceStatus.spent) {
                var redeemScriptHex = Buffer.from(generateHtlc(lease.refund_pubkey, lease.buyer_pubkey, lease.payment_hash, lease.timelock)).toString("hex");
                var found = await findHtlcSpend(lease.verified_htlc_address, lease.payment_hash, redeemScriptHex);
                if (!found) {
                    await waitSomeSeconds(30);
                    continue;
                }
                if (!found.preimage) {
                    found.txid;
                    resolveLease(lease_id, "spent with no preimage found -- funds conclusively gone regardless of why");
                    activeWatchers.delete(lease_id);
                    return;
                }
                var confirmed = await waitForOneConfirmation(found.txid, function() {
                    return checkOwnInvoiceStatus(lease.payment_hash);
                });
                var settledOk = false;
                if (confirmed && !watcherState.cancelled) {
                    if (lease.holdInvoiceAmount) settledOk = await settleOwnInvoiceUntilDone(found.preimage, lease.payment_hash);
                } else if (!confirmed) ;
                resolveLease(lease_id, !confirmed ? "sweep found, but the compensation invoice was cancelled/expired before it confirmed" : settledOk ? "sweep confirmed and settled" : "sweep confirmed, but the compensation invoice was cancelled/expired before it could be settled -- not paid");
                activeWatchers.delete(lease_id);
                return;
            }
            var blockheight = await getBlockheight();
            if (blockheight >= lease.timelock + TIMELOCK_TRIGGER_BUFFER_BLOCKS) {
                var htlcUtxos = await rpcResult("getaddressutxos", [ {
                    addresses: [ lease.verified_htlc_address ]
                } ]) || [];
                if (lease.asset_name) htlcUtxos = htlcUtxos.concat(await rpcResult("getaddressutxos", [ {
                    addresses: [ lease.verified_htlc_address ],
                    assetName: lease.asset_name
                } ]) || []);
                if (!htlcUtxos.length || lease.asset_name && htlcUtxos.length < 2) {
                    tries += 1;
                    if (tries % 120 === 0) ;
                    await waitSomeSeconds(30);
                    continue;
                }
                var fundingTxid, fundingVout, assetInput;
                if (lease.asset_name) {
                    var classified = [];
                    var hu;
                    for (hu = 0; hu < htlcUtxos.length; hu++) {
                        var cand = htlcUtxos[hu];
                        var cTxid = cand.tx_hash || cand.txid;
                        var cVout = cand.tx_pos !== void 0 ? cand.tx_pos : cand.outputIndex;
                        var script;
                        if (cand.script) script = Buffer.from(cand.script, "hex"); else {
                            var rawCandTx = await getRawTxHex(cTxid);
                            script = evrmorejs.Transaction.fromHex(rawCandTx).outs[cVout].script;
                        }
                        classified.push({
                            txid: cTxid,
                            vout: cVout,
                            isAsset: outputHasAssetTail(script)
                        });
                    }
                    var assetLeg = classified.filter(function(c) {
                        return c.isAsset;
                    });
                    var evrLeg = classified.filter(function(c) {
                        return !c.isAsset;
                    });
                    if (assetLeg.length !== 1 || evrLeg.length !== 1) {
                        assetLeg.length, evrLeg.length;
                        await waitSomeSeconds(30);
                        continue;
                    }
                    fundingTxid = evrLeg[0].txid;
                    fundingVout = evrLeg[0].vout;
                    assetInput = {
                        txid: assetLeg[0].txid,
                        vout: assetLeg[0].vout
                    };
                } else {
                    var fundingUtxo = htlcUtxos[0];
                    fundingTxid = fundingUtxo.tx_hash || fundingUtxo.txid;
                    fundingVout = fundingUtxo.tx_pos !== void 0 ? fundingUtxo.tx_pos : fundingUtxo.outputIndex;
                }
                if (lease.refund_key_counter === void 0 || lease.refund_key_counter === null) {
                    lease.refund_pubkey;
                    activeWatchers.delete(lease_id);
                    return;
                }
                var refundKeyEntry = {
                    privkey: deriveRefundPrivkeyHex(lease.refund_key_counter)
                };
                var witnessScriptHex = Buffer.from(generateHtlc(lease.refund_pubkey, lease.buyer_pubkey, lease.payment_hash, lease.timelock)).toString("hex");
                var refund_feerate = await getMinFeeRate();
                var refund_fee = (lease.asset_name ? 350 + 150 + 34 + ASSET_TAIL_MAX_BYTES : 350) * Number(refund_feerate);
                var recovery_tx = await recoverSats(refundKeyEntry.privkey, fundingTxid, fundingVout, lease.amount, sellerAddress, lease.amount - refund_fee, 4294967294, witnessScriptHex, lease.timelock, assetInput, lease.asset_name, lease.asset_amount);
                var refundTxid = await broadcastRawTx(recovery_tx);
                if (!refundTxid) {
                    await waitSomeSeconds(30);
                    continue;
                }
                if (lease.holdInvoiceAmount) await cancelHoldInvoice({
                    payment_hash: lease.payment_hash
                });
                resolveLease(lease_id, "refund transaction broadcast");
                activeWatchers.delete(lease_id);
                return;
            }
            await waitSomeSeconds(30);
        } catch (e) {
            e.message;
            await waitSomeSeconds(30);
        }
    }
}

async function makeHoldInvoice(req) {
    var lease = leases.get(req.lease_id);
    if (!lease) return {
        error: "no lease with id " + req.lease_id
    };
    if (lease.payment_hash !== req.payment_hash) return {
        error: "payment_hash does not match the lease's own payment_hash"
    };
    var expectedLsats = expectedCompensationLsats(lease);
    if (!(Number(req.amount) >= expectedLsats - COMPENSATION_ROUNDING_TOLERANCE_LSATS)) return {
        error: "compensation of " + req.amount + " L-sats is below this seller's price for the lease (" + expectedLsats + " L-sats)"
    };
    var cltvExpiry = Math.max(Number(req.expiry) || 0, MIN_COMPENSATION_INVOICE_CLTV);
    var invoice = await getHodlInvoice(req.amount, req.payment_hash, cltvExpiry);
    if (!invoice) return {
        error: "failed to create hold invoice"
    };
    lease.holdInvoiceAmount = Number(req.amount);
    persistState();
    var created_at = Math.floor(Date.now() / 1e3);
    return {
        invoice: invoice,
        payment_hash: req.payment_hash,
        amount: Number(req.amount),
        created_at: created_at,
        expires_at: created_at + cltvExpiry * 600,
        type: "incoming"
    };
}

async function cancelHoldInvoiceRpc(req) {
    var matching = Array.from(leases.values()).filter(function(lease) {
        return lease.payment_hash === req.payment_hash;
    });
    if (!matching.length) return {
        error: "no lease with this payment hash"
    };
    if (matching.some(function(lease) {
        return lease.state !== "leased";
    })) return {
        error: "this lease's funding is already signed -- its compensation invoice can't be cancelled on request"
    };
    return cancelHoldInvoice(req);
}

async function cancelHoldInvoice(req) {
    var pmthash = req.payment_hash;
    for (var [lease_id, lease] of leases) {
        if (lease.payment_hash !== pmthash) continue;
        var watcherState = activeWatchers.get(lease_id);
        if (watcherState) watcherState.cancelled = true;
    }
    var done = "";
    const macaroon = sellermac;
    const endpoint = lndendpoint;
    let requestBody = {
        payment_hash: Buffer.from(pmthash, "hex").toString("base64")
    };
    let options = {
        url: endpoint + "/v2/invoices/cancel",
        rejectUnauthorized: false,
        json: true,
        timeout: 15e3,
        headers: {
            "Grpc-Metadata-macaroon": macaroon
        },
        form: JSON.stringify(requestBody)
    };
    JSON.stringify(requestBody);
    request.post(options, function(error, response, body) {
        if (!error && response && response.statusCode === 200) {
            JSON.stringify(body);
            done = "true";
        } else {
            error && (error.message || error) || body && (body.message || JSON.stringify(body));
            done = "false";
        }
    });
    async function isNoteSetYet(note_i_seek) {
        return new Promise(function(resolve, reject) {
            if (note_i_seek == "") setTimeout(async function() {
                var msg = await isNoteSetYet(done);
                resolve(msg);
            }, 100); else resolve(note_i_seek);
        });
    }
    async function getTimeoutData() {
        var invoice_i_seek = await isNoteSetYet(done);
        return invoice_i_seek;
    }
    var returnable = await getTimeoutData();
    if (returnable !== "true") ;
    return returnable;
}

function promptTerminal(question) {
    return new Promise(function(resolve) {
        var rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        rl.question(question, function(answer) {
            rl.close();
            resolve(answer.trim());
        });
    });
}

function decodeNsec(nsecStr) {
    var CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    function polymod(values) {
        var GEN = [ 996825010, 642813549, 513874426, 1027748829, 705979059 ];
        var chk = 1;
        for (var p = 0; p < values.length; p++) {
            var top = chk >>> 25;
            chk = (chk & 33554431) << 5 ^ values[p];
            for (var i = 0; i < 5; i++) if (top >>> i & 1) chk ^= GEN[i];
        }
        return chk >>> 0;
    }
    function hrpExpand(hrp) {
        var ret = [];
        for (var i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
        ret.push(0);
        for (var i2 = 0; i2 < hrp.length; i2++) ret.push(hrp.charCodeAt(i2) & 31);
        return ret;
    }
    try {
        nsecStr = nsecStr.trim().toLowerCase();
        var sep = nsecStr.lastIndexOf("1");
        if (sep < 1 || sep + 7 > nsecStr.length) return null;
        var hrp = nsecStr.slice(0, sep);
        if (hrp !== "nsec") return null;
        var dataPart = nsecStr.slice(sep + 1);
        var values = [];
        for (var i = 0; i < dataPart.length; i++) {
            var idx = CHARSET.indexOf(dataPart[i]);
            if (idx === -1) return null;
            values.push(idx);
        }
        if (polymod(hrpExpand(hrp).concat(values)) !== 1) return null;
        var words = values.slice(0, -6);
        var acc = 0, bits = 0, bytes = [];
        for (var w = 0; w < words.length; w++) {
            acc = (acc << 5 | words[w]) >>> 0;
            bits += 5;
            if (bits >= 8) {
                bits -= 8;
                bytes.push(acc >>> bits & 255);
            }
        }
        if (bytes.length !== 32) return null;
        return bytes.map(function(b) {
            return b.toString(16).padStart(2, "0");
        }).join("");
    } catch (e) {
        return null;
    }
}

async function resolveSellerIdKey(sellerIdKeyField) {
    var field = sellerIdKeyField;
    if (typeof field === "number") process.exit(1);
    if (field === void 0 || field === "") {
        field = await promptTerminal("seller_id_key not set -- enter a 64-char hex key, an nsec1... key, or press enter for a random one: ");
        if (field === "") field = "random";
    }
    if (field === "random") return Buffer.from(ECPair.makeRandom().privateKey).toString("hex");
    var trimmed = field.trim();
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed.toLowerCase();
    var decoded = decodeNsec(trimmed);
    if (decoded) return decoded;
    return Buffer.from(ECPair.makeRandom().privateKey).toString("hex");
}

async function resolveAllowEphemeral(allowEphemeralField, sellerIdKeyField) {
    if (allowEphemeralField === "yes" || allowEphemeralField === "no") return allowEphemeralField;
    var sellerIsRandom = !sellerIdKeyField || sellerIdKeyField === "random";
    var suggestion = sellerIsRandom ? "yes" : "no";
    var explanation = sellerIsRandom ? "your own seller_id_key is 'random', so durable pairing isn't achievable either way this restarts -- accepting an ephemeral swapservice costs nothing extra" : "your seller_id_key is a fixed key, so pairing with an ephemeral swapservice would mean paying for identity stability without actually getting durable pairing back";
    var answer = await promptTerminal("allow_ephemeral_swapservice not set (" + explanation + ", suggested: " + suggestion + ") -- allow pairing with an ephemeral-identity swapservice? [" + suggestion + "]: ");
    if (answer === "") return suggestion;
    return answer.toLowerCase() === "yes" ? "yes" : "no";
}

function normalizeRelayURL(e) {
    let [t, ...r] = e.trim().split("?");
    return "http" === t.slice(0, 4) && (t = "ws" + t.slice(4)), "ws" !== t.slice(0, 2) && (t = "wss://" + t), 
    t.length && "/" === t[t.length - 1] && (t = t.slice(0, -1)), [ t, ...r ].join("?");
}

function parseRelayList(raw) {
    return (raw || "").split(",").map(function(s) {
        return s.trim();
    }).filter(Boolean).map(normalizeRelayURL);
}

var relays = parseRelayList(config.relay);

var NIP44_VERSION = 2;

var NIP44_MIN_PLAINTEXT_LEN = 1;

var NIP44_MAX_PLAINTEXT_LEN = 65535;

function nip44Utf8ToBytes(str) {
    return Uint8Array.from(Buffer.from(str, "utf8"));
}

function nip44BytesToUtf8(bytes) {
    return Buffer.from(bytes).toString("utf8");
}

function nip44ConcatBytes() {
    var arrs = Array.prototype.slice.call(arguments);
    var total = arrs.reduce(function(sum, a) {
        return sum + a.length;
    }, 0);
    var out = new Uint8Array(total);
    var offset = 0;
    arrs.forEach(function(a) {
        out.set(a, offset);
        offset += a.length;
    });
    return out;
}

function nip44GetConversationKey(privkeyHex, pubkeyHex) {
    var sharedX = Uint8Array.from(Buffer.from(nobleSecp256k1.getSharedSecret(privkeyHex, "02" + pubkeyHex, true).substring(2), "hex"));
    return hkdfExtract(nobleSha256, sharedX, nip44Utf8ToBytes("nip44-v2"));
}

function nip44GetMessageKeys(conversationKey, nonce) {
    var expanded = hkdfExpand(nobleSha256, conversationKey, nonce, 76);
    return {
        chachaKey: expanded.slice(0, 32),
        chachaNonce: expanded.slice(32, 44),
        hmacKey: expanded.slice(44, 76)
    };
}

function nip44CalcPaddedLen(unpaddedLen) {
    if (unpaddedLen <= 32) return 32;
    var nextPower = Math.pow(2, Math.floor(Math.log2(unpaddedLen - 1)) + 1);
    var chunk = nextPower <= 256 ? 32 : nextPower / 8;
    return chunk * (Math.floor((unpaddedLen - 1) / chunk) + 1);
}

function nip44Pad(plaintextBytes) {
    var len = plaintextBytes.length;
    if (len < NIP44_MIN_PLAINTEXT_LEN || len > NIP44_MAX_PLAINTEXT_LEN) throw new Error("nip44: plaintext length " + len + " is outside the allowed range [1, 65535]");
    var prefix = new Uint8Array(2);
    prefix[0] = len >> 8 & 255;
    prefix[1] = len & 255;
    var paddedLen = nip44CalcPaddedLen(len);
    return nip44ConcatBytes(prefix, plaintextBytes, new Uint8Array(paddedLen - len));
}

function nip44Unpad(paddedBytes) {
    if (paddedBytes.length < 2) throw new Error("nip44: padded plaintext too short");
    var len = paddedBytes[0] << 8 | paddedBytes[1];
    var plaintextBytes = paddedBytes.slice(2, 2 + len);
    if (len < NIP44_MIN_PLAINTEXT_LEN || len > NIP44_MAX_PLAINTEXT_LEN || plaintextBytes.length !== len || paddedBytes.length !== 2 + nip44CalcPaddedLen(len)) throw new Error("nip44: invalid padding");
    return plaintextBytes;
}

function encrypt(privkey, pubkey, text) {
    var conversationKey = nip44GetConversationKey(privkey, pubkey);
    var nonce = Uint8Array.from(crypto.randomBytes(32));
    var keys = nip44GetMessageKeys(conversationKey, nonce);
    var padded = nip44Pad(nip44Utf8ToBytes(text));
    var ciphertext = chacha20(keys.chachaKey, keys.chachaNonce, padded, void 0, 0);
    var mac = hmac(nobleSha256, keys.hmacKey, nip44ConcatBytes(nonce, ciphertext));
    return Buffer.from(nip44ConcatBytes(Uint8Array.of(NIP44_VERSION), nonce, ciphertext, mac)).toString("base64");
}

function decrypt(privkey, pubkey, ciphertext) {
    try {
        if (typeof ciphertext !== "string" || ciphertext.length === 0 || ciphertext[0] === "#") throw new Error("nip44: unknown encryption version");
        var decoded = Uint8Array.from(Buffer.from(ciphertext, "base64"));
        if (decoded[0] !== NIP44_VERSION) throw new Error("nip44: unknown encryption version " + decoded[0]);
        if (decoded.length < 1 + 32 + 32) throw new Error("nip44: payload too short");
        var nonce = decoded.slice(1, 33);
        var mac = decoded.slice(decoded.length - 32);
        var ciphertextBytes = decoded.slice(33, decoded.length - 32);
        var conversationKey = nip44GetConversationKey(privkey, pubkey);
        var keys = nip44GetMessageKeys(conversationKey, nonce);
        var expectedMac = hmac(nobleSha256, keys.hmacKey, nip44ConcatBytes(nonce, ciphertextBytes));
        if (!equalBytes(mac, expectedMac)) throw new Error("nip44: invalid MAC");
        var padded = chacha20(keys.chachaKey, keys.chachaNonce, ciphertextBytes, void 0, 0);
        return nip44BytesToUtf8(nip44Unpad(padded));
    } catch (e) {
        return "error decrypting message -- the message was malformed";
    }
}

async function getSignedEvent(event, privateKey) {
    var eventData = JSON.stringify([ 0, event["pubkey"], event["created_at"], event["kind"], event["tags"], event["content"] ]);
    const eventDataBuffer = Buffer.from(eventData);
    event.id = Buffer.from(evrmorejs.crypto.sha256(eventDataBuffer)).toString("hex");
    event.sig = await nobleSecp256k1.schnorr.sign(event.id, privateKey);
    return event;
}

async function verifyEvent(event) {
    try {
        var eventData = JSON.stringify([ 0, event["pubkey"], event["created_at"], event["kind"], event["tags"], event["content"] ]);
        var computedId = Buffer.from(evrmorejs.crypto.sha256(Buffer.from(eventData))).toString("hex");
        if (computedId !== event["id"]) return false;
        return await nobleSecp256k1.schnorr.verify(event["sig"], event["id"], event["pubkey"]);
    } catch (e) {
        return false;
    }
}

function isValidJson(content) {
    if (!content) return;
    try {
        var json = JSON.parse(content);
    } catch (e) {
        return;
    }
    return true;
}

function isHex(h) {
    if (typeof h !== "string" || !/^[0-9a-fA-F]*$/.test(h)) return false;
    var length = h.length;
    if (length % 2) return;
    if (length > 66) return;
    var a = BigInt("0x" + h, "hex");
    var unpadded = a.toString(16);
    var padding = "000000000000000000000000000000000000000000000000000000000000000000";
    padding += unpadded.toString();
    padding = padding.slice(-Math.abs(length));
    return padding === h;
}

var sellerNostrPrivkey = null;

var sellerNostrPubkey = null;

var pairedSwapservicePubkeys = new Set;

var relayConnections = relays.map(function(url) {
    return {
        url: url,
        client: null,
        activeConnection: null
    };
});

var hasBootstrapped = false;

var sellerAllowEphemeral = null;

function browseCoordinatorAds(windowMs) {
    var ads = [];
    var seenPubkeys = {};
    async function onMessage(message) {
        try {
            var [type, subId, event] = JSON.parse(message.utf8Data);
            if (type !== "EVENT" || !event || event.kind !== coordinatorAdKind) return;
            if (!await verifyEvent(event)) return;
            if (seenPubkeys[event.pubkey]) return;
            var content = JSON.parse(event.content);
            if (content.network !== config.network) return;
            seenPubkeys[event.pubkey] = true;
            ads.push({
                pubkey: event.pubkey,
                network: content.network,
                fee: content.fee,
                fee_type: content.fee_type,
                persistence: content.persistent_or_ephemeral,
                seller_protocol_version: content.seller_protocol_version,
                supported_asset_name: content.supported_asset_name || ""
            });
        } catch (e) {}
    }
    var listenedConns = relayConnections.filter(function(conn) {
        return conn.activeConnection;
    });
    listenedConns.forEach(function(conn) {
        conn.activeConnection.on("message", onMessage);
    });
    return new Promise(function(resolve) {
        setTimeout(function() {
            listenedConns.forEach(function(conn) {
                conn.activeConnection.removeListener("message", onMessage);
            });
            resolve(ads);
        }, windowMs || 1e4);
    });
}

function adAcceptsThisSeller(ad, sellerAssetName) {
    if (!ad.supported_asset_name) return true;
    if (ad.supported_asset_name === "EVR") return !sellerAssetName;
    return ad.supported_asset_name === sellerAssetName;
}

function selectSwapservicesToPair(ads, alreadyPaired, swapserviceKeys, allowEphemeral, remainingCapacity, sellerAssetName) {
    if (remainingCapacity <= 0) return [];
    if (swapserviceKeys && swapserviceKeys.length) {
        var picked = [];
        for (var key of swapserviceKeys) {
            if (alreadyPaired.has(key)) continue;
            var ad = ads.find(function(ad) {
                return ad.pubkey === key;
            });
            if (!ad) continue;
            if (ad.persistence === "ephemeral" && allowEphemeral === "no") continue;
            if (ad.seller_protocol_version !== SELLER_PROTOCOL_VERSION) {
                ad.seller_protocol_version;
                continue;
            }
            if (!adAcceptsThisSeller(ad, sellerAssetName)) {
                ad.supported_asset_name;
                continue;
            }
            picked.push(key);
            if (picked.length >= remainingCapacity) break;
        }
        return picked;
    }
    var candidates = ads.filter(function(ad) {
        return ad.seller_protocol_version === SELLER_PROTOCOL_VERSION && !alreadyPaired.has(ad.pubkey) && adAcceptsThisSeller(ad, sellerAssetName);
    });
    if (allowEphemeral === "no") candidates = candidates.filter(function(ad) {
        return ad.persistence !== "ephemeral";
    });
    return candidates.slice(0, remainingCapacity).map(function(ad) {
        return ad.pubkey;
    });
}

async function sendPairingHandshake(swapservicePubkey) {
    var maxAttempts = 3;
    for (var attempt = 1; attempt <= maxAttempts; attempt++) {
        var ok = await attemptSendHandshake(swapservicePubkey);
        if (ok) return true;
    }
    return false;
}

async function attemptSendHandshake(swapservicePubkey) {
    var now = Math.floor(Date.now() / 1e3);
    var content = encrypt(sellerNostrPrivkey, swapservicePubkey, JSON.stringify({
        type: "pair_request",
        network: config.network,
        seller_protocol_version: SELLER_PROTOCOL_VERSION
    }));
    var event = {
        pubkey: sellerNostrPubkey,
        created_at: now,
        kind: dmKind,
        tags: [ [ "p", swapservicePubkey ] ],
        content: content
    };
    var signed = await getSignedEvent(event, sellerNostrPrivkey);
    var acked = false, settled = false;
    function onMessage(message) {
        try {
            var parsed = JSON.parse(message.utf8Data);
            if (parsed[0] === "OK" && parsed[1] === signed.id) {
                acked = !!parsed[2];
                settled = true;
            }
        } catch (e) {}
    }
    var listenedConns = relayConnections.filter(function(conn) {
        return conn.activeConnection;
    });
    listenedConns.forEach(function(conn) {
        conn.activeConnection.on("message", onMessage);
    });
    JSON.stringify([ "EVENT", signed ]);
    broadcastToAllRelays(JSON.stringify([ "EVENT", signed ]));
    var elapsedMs = 0;
    while (!settled && elapsedMs < 5e3) {
        await waitSomeSecondsFraction(100);
        elapsedMs += 100;
    }
    listenedConns.forEach(function(conn) {
        conn.activeConnection.removeListener("message", onMessage);
    });
    return acked;
}

function waitSomeSecondsFraction(ms) {
    return new Promise(function(resolve) {
        setTimeout(resolve, ms);
    });
}

var processedRequests = new Map;

var RPC_CACHE_TTL_MS = 10 * 60 * 1e3;

var rpcMethods = {
    get_refund_pubkey: getRefundPubkey,
    lease_utxos: leaseUtxos,
    sign_psbt: signPsbt,
    get_config: getConfig,
    make_hold_invoice: makeHoldInvoice,
    cancel_hold_invoice: cancelHoldInvoiceRpc,
    has_sufficient_balance: hasSufficientBalance
};

async function handleRpcRequest(event) {
    if (!pairedSwapservicePubkeys.has(event.pubkey)) {
        event.pubkey;
        return;
    }
    var decrypted = decrypt(sellerNostrPrivkey, event.pubkey, event.content);
    if (!isValidJson(decrypted)) return;
    var req = JSON.parse(decrypted);
    if (!req.id || !req.method || typeof req.params !== "object") return;
    var now = Date.now();
    for (var [id, entry] of processedRequests) if (entry.expires_at < now) processedRequests.delete(id);
    var response;
    var cached = processedRequests.get(req.id);
    if (cached) response = cached.response; else {
        var handler = rpcMethods[req.method];
        if (!handler) response = {
            id: req.id,
            error: "unknown method: " + req.method
        }; else try {
            var result = await handler(req.params);
            response = result && result.error ? Object.assign({
                id: req.id
            }, result) : {
                id: req.id,
                result: result
            };
        } catch (e) {
            response = {
                id: req.id,
                error: e.message
            };
        }
        processedRequests.set(req.id, {
            response: response,
            expires_at: now + RPC_CACHE_TTL_MS
        });
    }
    var responseContent = encrypt(sellerNostrPrivkey, event.pubkey, JSON.stringify(response));
    var responseEvent = {
        pubkey: sellerNostrPubkey,
        created_at: Math.floor(Date.now() / 1e3),
        kind: rpcKind,
        tags: [ [ "p", event.pubkey ] ],
        content: responseContent
    };
    var signedResponse = await getSignedEvent(responseEvent, sellerNostrPrivkey);
    req.method, JSON.stringify([ "EVENT", signedResponse ]);
    broadcastToAllRelays(JSON.stringify([ "EVENT", signedResponse ]));
}

function doConnect(conn) {
    conn.client = new WebSocketClient({
        keepalive: true,
        keepaliveInterval: 2e4,
        dropConnectionOnKeepaliveTimeout: true,
        keepaliveGracePeriod: 1e4
    });
    conn.client.on("connect", function(connection) {
        conn.activeConnection = connection;
        onRelayConnect(conn);
    });
    conn.client.on("close", function() {
        conn.url;
        conn.client.connect(conn.url);
    });
    conn.client.connect(conn.url);
}

function reconnectRelay(conn) {
    if (conn.activeConnection) try {
        conn.activeConnection.close();
    } catch (e) {}
    doConnect(conn);
}

function reconnect() {
    relayConnections.forEach(reconnectRelay);
}

function checkHeartbeat() {
    setTimeout(() => {
        relayConnections.forEach(function(conn) {
            if (!conn.activeConnection || !conn.activeConnection.connected) {
                conn.url;
                reconnectRelay(conn);
            }
        });
        checkHeartbeat();
    }, 2e3);
}

function broadcastToAllRelays(raw) {
    var sentToAny = false;
    relayConnections.forEach(function(conn) {
        if (!conn.activeConnection) return;
        conn.url;
        try {
            conn.activeConnection.sendUTF(raw);
            conn.url;
            sentToAny = true;
        } catch (e) {
            conn.url, e.message;
        }
    });
    return sentToAny;
}

async function onRelayConnect(conn) {
    var connection = conn.activeConnection;
    conn.url;
    connection.on("error", function(error) {});
    connection.on("message", async function(message) {
        var parsed;
        try {
            parsed = JSON.parse(message.utf8Data);
        } catch (e) {
            return;
        }
        var [type, subId, event] = parsed;
        if (type !== "EVENT" || !event) return;
        if (event.kind === rpcKind) {
            if (!await verifyEvent(event)) return;
            await handleRpcRequest(event);
            return;
        }
        if (event.kind === dmKind) {
            if (!await verifyEvent(event)) return;
            var dmContent;
            try {
                dmContent = decrypt(sellerNostrPrivkey, event.pubkey, event.content);
            } catch (e) {
                return;
            }
            if (!isValidJson(dmContent)) return;
            var dmJson = JSON.parse(dmContent);
            if (dmJson.type === "pair_ack") event.pubkey; else if (dmJson.type === "pair_reject") event.pubkey, 
            dmJson.reason, dmJson.swapservice_network, dmJson.swapservice_seller_protocol_version;
            return;
        }
    });
    var subId = crypto.randomBytes(16).toString("hex");
    var filter1 = {
        kinds: [ coordinatorAdKind ]
    };
    var filter2 = {
        kinds: [ rpcKind ],
        "#p": [ sellerNostrPubkey ]
    };
    var filter3 = {
        kinds: [ dmKind ],
        "#p": [ sellerNostrPubkey ]
    };
    var subscription = JSON.stringify([ "REQ", subId, filter1, filter2, filter3 ]);
    setTimeout(function() {
        conn.url;
        try {
            connection.sendUTF(subscription);
        } catch (e) {
            conn.url, e.message;
        }
    }, 1e3);
    if (hasBootstrapped) return;
    hasBootstrapped = true;
    while (pairedSwapservicePubkeys.size < maxPairedSwapservices) {
        pairedSwapservicePubkeys.size;
        var ads = await browseCoordinatorAds(1e4);
        var remainingCapacity = maxPairedSwapservices - pairedSwapservicePubkeys.size;
        var picked = selectSwapservicesToPair(ads, pairedSwapservicePubkeys, swapserviceKeysList, sellerAllowEphemeral, remainingCapacity, asset_name);
        if (!picked.length) continue;
        await Promise.all(picked.map(async function(pubkey) {
            pairedSwapservicePubkeys.add(pubkey);
            var ok = await sendPairingHandshake(pubkey);
            if (!ok) pairedSwapservicePubkeys.delete(pubkey);
        }));
    }
}

function resumeOpenLeases() {
    var resumedCount = 0;
    for (var [lease_id, lease] of leases) {
        if (lease.state !== "signed" && lease.state !== "funded") continue;
        resumedCount += 1;
        watchLease(lease_id).catch(function(e) {
            e.message;
        });
    }
    if (resumedCount > 0) ;
}

var HEARTBEAT_FILE = config.heartbeat_file || "seller-heartbeat.json";

var HEARTBEAT_INTERVAL_MS = 30 * 1e3;

var processStartedAt = (new Date).toISOString();

function writeHeartbeatFile() {
    var leaseCounts = {};
    leases.forEach(function(lease) {
        leaseCounts[lease.state] = (leaseCounts[lease.state] || 0) + 1;
    });
    var status = {
        process: "seller",
        pid: process.pid,
        ts: (new Date).toISOString(),
        started_at: processStartedAt,
        uptime_s: Math.round(process.uptime()),
        network: config.network,
        nostr_pubkey: sellerNostrPubkey,
        evr_address: sellerAddress,
        asset_name: asset_name || null,
        relays: relayConnections.map(function(conn) {
            return {
                url: conn.url,
                connected: !!(conn.activeConnection && conn.activeConnection.connected)
            };
        }),
        paired_swapservices: Array.from(pairedSwapservicePubkeys),
        leases: leaseCounts,
        halted_due_to_inconsistency: haltedDueToInconsistency,
        memory_rss_mb: Math.round(process.memoryUsage().rss / 1048576)
    };
    var tmpPath = HEARTBEAT_FILE + ".tmp";
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(status) + "\n");
        fs.renameSync(tmpPath, HEARTBEAT_FILE);
    } catch (e) {
        e.message;
    }
}

function startHeartbeatFile() {
    writeHeartbeatFile();
    setInterval(writeHeartbeatFile, HEARTBEAT_INTERVAL_MS);
}

async function startSeller() {
    loadPersistedState();
    sellerNostrPrivkey = await resolveSellerIdKey(config.seller_id_key);
    sellerNostrPubkey = nobleSecp256k1.getPublicKey(sellerNostrPrivkey, true).substring(2);
    sellerAllowEphemeral = await resolveAllowEphemeral(config.allow_ephemeral_swapservice, config.seller_id_key);
    resumeOpenLeases();
    startReconciliationLoop();
    reconnect();
    checkHeartbeat();
    startHeartbeatFile();
}

if (require.main === module) startSeller();

module.exports = {
    leaseUtxos: leaseUtxos,
    signPsbt: signPsbt,
    getConfig: getConfig,
    makeHoldInvoice: makeHoldInvoice,
    cancelHoldInvoice: cancelHoldInvoice,
    getRefundPubkey: getRefundPubkey,
    startSeller: startSeller,
    sellerAddress: sellerAddress,
    hasSufficientBalance: hasSufficientBalance,
    selectFundingUtxos: selectFundingUtxos,
    recoverSats: recoverSats,
    outputHasAssetTail: outputHasAssetTail,
    reconcileLeases: reconcileLeases,
    get haltedDueToInconsistency() {
        return haltedDueToInconsistency;
    },
    watchLease: watchLease,
    refundKeys: refundKeys,
    leases: leases,
    activeWatchers: activeWatchers,
    deriveRefundPrivkeyHex: deriveRefundPrivkeyHex,
    persistState: persistState,
    loadPersistedState: loadPersistedState,
    resumeOpenLeases: resumeOpenLeases,
    get refundKeyCounter() {
        return refundKeyCounter;
    },
    pairedSwapservicePubkeys: pairedSwapservicePubkeys,
    selectSwapservicesToPair: selectSwapservicesToPair,
    handleRpcRequest: handleRpcRequest,
    currentAggregateExposure: currentAggregateExposure,
    encrypt: encrypt,
    decrypt: decrypt,
    get sellerNostrPrivkey() {
        return sellerNostrPrivkey;
    },
    set sellerNostrPrivkey(v) {
        sellerNostrPrivkey = v;
    },
    get sellerNostrPubkey() {
        return sellerNostrPubkey;
    },
    set sellerNostrPubkey(v) {
        sellerNostrPubkey = v;
    },
    get activeConnection() {
        return relayConnections[0] && relayConnections[0].activeConnection;
    },
    set activeConnection(v) {
        relayConnections[0].activeConnection = v;
    },
    normalizeRelayURL: normalizeRelayURL,
    parseRelayList: parseRelayList,
    broadcastToAllRelays: broadcastToAllRelays,
    sendPairingHandshake: sendPairingHandshake,
    reconnect: reconnect,
    get relays() {
        return relays;
    },
    relayConnections: relayConnections
};