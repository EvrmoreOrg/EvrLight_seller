// Last-resort manual recovery tool -- NOT wired into the running service,
// never imported by seller.js. Not reachable by swapservice or any RPC
// caller either -- releasing a lease early is exactly the kind of action
// that has to stay under the seller operator's own direct control, never
// the (untrusted) coordinator's.
//
// Why this exists: as of the "funded" lease-state fix (see seller.js's own
// currentAggregateExposure()/resolveLease() comments), a lease only ever
// leaves `leases` (and stops counting against max_aggregate_exposure_evr)
// once watchLease() reaches a genuine, known outcome for it -- a settled
// sweep or a broadcast refund. Two of watchLease()'s own exit points are
// deliberately left un-resolved when the real outcome is unknown (a
// missing refund_key_counter, or the watcher giving up after ~130 minutes
// without ever seeing the HTLC resolve) -- correctly conservative, since
// auto-clearing those could hide capital that's still genuinely at risk.
// But that means a lease stuck in one of those states (or stuck for any
// other reason nobody anticipated -- a bug, an odd crash) has no
// automated way back into `leases`, and would otherwise permanently eat
// into the operator's own configured aggregate-exposure budget. This
// script is that way back: run it OFFLINE (seller.js must not be running
// against the same lease-state file at the same time -- its own
// persistState() would just overwrite whatever this script wrote on its
// next mutation), after manually verifying on-chain that the deal in
// question has actually resolved.
//
// Usage:
//   node release-lease.js --list [--lease-state-file <path>]
//   node release-lease.js --release <lease_id> [--lease-state-file <path>] [--confirm]
//
// --list is read-only. --release without --confirm is a dry run: it prints
// exactly what would be removed and why you should double-check it first,
// but writes nothing. Re-run with --confirm once you've verified (e.g. via
// getaddressutxos, or a block explorer) that the HTLC at the printed
// verified_htlc_address has actually resolved, or that you're otherwise
// deliberately accepting the residual risk of releasing it anyway.

const fs = require('fs');

function parseArgs( argv ) {
    var result = {};
    for ( var i = 0; i < argv.length; i++ ) {
        if ( argv[i].startsWith( "--" ) ) {
            var key = argv[i].slice( 2 );
            var next = argv[i + 1];
            if ( next === undefined || next.startsWith( "--" ) ) {
                result[ key ] = true; // flag with no value, e.g. --confirm
            } else {
                result[ key ] = next;
                i = i + 1;
            }
        }
    }
    return result;
}

var args = parseArgs( process.argv.slice(2) );
// same default as seller.js's own `config.lease_state_file || "seller-lease-state.json"`
var leaseStateFile = args[ "lease-state-file" ] || "seller-lease-state.json";

if ( !args.list && !args.release ) {
    console.log( "Usage:" );
    console.log( "  node release-lease.js --list [--lease-state-file <path>]" );
    console.log( "  node release-lease.js --release <lease_id> [--lease-state-file <path>] [--confirm]" );
    process.exit(1);
}

if ( !fs.existsSync( leaseStateFile ) ) {
    console.log( "Error: lease state file not found:", leaseStateFile );
    process.exit(1);
}

var data;
try {
    data = JSON.parse( fs.readFileSync( leaseStateFile, "utf8" ) );
} catch ( e ) {
    console.log( "Error: failed to read/parse " + leaseStateFile + ":", e.message );
    process.exit(1);
}
var leaseEntries = data.leases || []; // [ [lease_id, lease], ... ], same Array.from(Map.entries()) shape persistState() writes

// this deliberately does NOT attempt to recompute each lease's own EVR-
// equivalent exposure value the way seller.js's exposureValueEvrSats()
// does -- that needs the paired seller's *current* rate_asset_per_btc/
// rate_evr_per_btc, which aren't stored per-lease and may have moved since
// this lease was created, so any number this script printed would be a
// stale approximation dressed up as precise. Printing the raw fields
// (amount, asset_name, asset_amount) instead lets the operator do that
// math themselves against whatever rate they actually trust right now.
function describeLease( lease_id, lease ) {
    var lines = [];
    lines.push( "lease_id: " + lease_id );
    lines.push( "  state: " + lease.state );
    var ageMs = lease.funded_at ? ( Date.now() - lease.funded_at )
        : lease.signed_at ? ( Date.now() - lease.signed_at )
        : null;
    lines.push( "  age: " + ( ageMs !== null ? ( Math.round( ageMs / 60000 ) + " minutes since " + ( lease.funded_at ? "funded" : "signed" ) ) : "n/a (still \"leased\", short-lived reservation TTL, not a candidate for manual release)" ) );
    lines.push( "  amount: " + ( Number( lease.amount ) / 1e8 ) + " EVR" + ( lease.asset_name ? " (this is only the small bundled EVR leg in asset-mode -- see asset_amount below for the real traded quantity)" : "" ) );
    if ( lease.asset_name ) {
        lines.push( "  asset_name: " + lease.asset_name );
        lines.push( "  asset_amount: " + ( Number( lease.asset_amount ) / 1e8 ) );
    }
    lines.push( "  verified_htlc_address: " + lease.verified_htlc_address );
    lines.push( "  payment_hash: " + lease.payment_hash );
    return lines.join( "\n" );
}

if ( args.list ) {
    if ( !leaseEntries.length ) {
        console.log( "No leases in " + leaseStateFile + "." );
        process.exit(0);
    }
    console.log( leaseEntries.length + " lease(s) in " + leaseStateFile + ":\n" );
    leaseEntries.forEach( function( entry ) {
        console.log( describeLease( entry[0], entry[1] ) + "\n" );
    });
    process.exit(0);
}

// --release from here down
var targetId = args.release;
var targetIndex = leaseEntries.findIndex( function( entry ) { return entry[0] === targetId; } );
if ( targetIndex === -1 ) {
    console.log( "Error: no lease with id " + targetId + " in " + leaseStateFile + ". Run --list to see what's there." );
    process.exit(1);
}
var targetEntry = leaseEntries[ targetIndex ];

console.log( "About to release:\n" );
console.log( describeLease( targetEntry[0], targetEntry[1] ) );
console.log( "\nThis does NOT resolve anything on-chain by itself -- it only removes this lease from\n" +
    leaseStateFile + ", so it stops counting against max_aggregate_exposure_evr. Only do this after\n" +
    "manually confirming (e.g. via getaddressutxos, or a block explorer, against the\n" +
    "verified_htlc_address above) that the HTLC has actually resolved -- swept, refunded, or\n" +
    "otherwise a deal you're deliberately writing off -- or you will let this seller instance\n" +
    "over-commit capital beyond what you configured as its safety ceiling." );

if ( !args.confirm ) {
    console.log( "\n(--confirm not given -- nothing was written. Re-run with --confirm once you've verified the above.)" );
    process.exit(0);
}

// seller.js must not be running against this same file right now -- its
// own persistState() would just overwrite this write on its next mutation
leaseEntries.splice( targetIndex, 1 );
data.leases = leaseEntries;
var tmpPath = leaseStateFile + ".tmp";
fs.writeFileSync( tmpPath, JSON.stringify( data ) );
fs.renameSync( tmpPath, leaseStateFile ); // atomic on the same filesystem, same pattern as seller.js's own persistState()

console.log( "\n--confirm given -- lease " + targetId + " removed from " + leaseStateFile + "." );
