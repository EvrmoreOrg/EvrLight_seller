
# seller.js - the seller module of EvrLight

EvrLight is a technology which atomically trustlessly swaps EVR or an Evrmore asset (plus a
small amount of EVR) in exchange for Bitcoin Lightning payment

The seller.js Node.js application supplies the Evrmore side of the swap. That means the
seller is the party who owns the on-chain asset(s) before the swap. The seller determines
which Evrmore assets will be sold, must transfer the supply of those assets into an
Evrmore address which it controls, and must provide the corresponding private key for that
address to the seller.js application as the environment variable SELLER_PRIV_KEY. If an 
asset is being sold, then a supply of EVR must also be maintained in the same address 
because asset sales are always the sale of the asset bundled with a small amount of EVR to 
pay for the chain transaction fees. Note that it is best to maintain the assets and the EVR in
the address as multiple UTXOs to improve performance. When a sale is in process, the UTXO
containing the products being sold is frozen until that sale is complete. Having multiple
UTXOs makes it possible to process multiple sales in parallel. Five (5) asset UTXOs and
five (5) EVR UTXOs is a good starting point if you have a large quantity of assets to sell.

The seller specifies the minimum and maximum quantity of the sale. Most importantly, the 
seller also sets the EVR and asset prices for the sale, specified as the environment variables 
EVR_PER_BTC and ASSET_PER_BTC.  

To be clear, EvrLight serves as a bulletin board where sellers post offers to sell an
asset at their chosen price and quantity range. A buyer can see the sell offers and can
choose to take an offer at a quantity within the range set by the seller. But a buyer
never sets a price. All offers are "offer-to-sell" offers. There are no "offer-to-buy"
offers. The analogy is a farmer's market, not a stock exchange. In truth EvrLight 
allows every buyer to post one "price suggestion" for an asset but they serve only as 
informal price suggestions to sellers, and are not actionable offers.

One of the parameters which must be supplied in the configuration file is the private key 
which serves as the seller's identity. If the seller is a user of Nostr, then they already 
own a private/public keypair as their identity, which can also serve as the seller's ID. 
Using the Nostr ID key as the seller ID key sacrifices privacy for the transaction done
by the seller. But it has a corresponding advantage that buyers and relays can accumulate
reputation histories. Buyers may choose only to work with sellers who have a proven reputation.
Moreover, relays may charge small one-time or per-month EvrLight registration fees
to prevent spam and denial-of-service attacks. A seller using their Nostr ID key or any chosen
persistant key would only need to pay the fee once, while randomized sellers must pay each time.
For flexibility, the seller's private ID key can also be chosen randomly.

In order for the seller to receive payment in Bitcoin Lightning, the seller is required
to maintain an always-on LND Lightning node. The url:port of that node RPC interface as
well as the path to its authorization invoice.macaroon are needed in the seller.config file.

Note that the required maintenance of the Lightning node to collect the Bitcoin payments
makes being a seller much more complex than being a buyer (which is trivially simple).
In general, that is acceptable since merchants have more motivation and resources to learn
what is needed or to pay an expert to set it up. But I also expect hosted Lightning nodes
and other simplifications to become available in the future.

EvrLight is designed to be quite robust against a variety of errors, and will
automatically unwind most transactions which encounter problems. It also maintains a few
files such as active-seller-addresses.txt and seller-lease-state.json to help it avoid
problems and to automaticaally recover funds at re-start in case of a software or hardware
crash. Nevertheless, the computer on which seller.js and its Lightning node run should be
as robust and secure as possible since they are live Evrmore and Bitcoin wallets.

### <u>Installing the EvrLight seller module on your server:</u>

seller.js is a headless NodeJS application. It is best to run it on an Ubuntu Linux server due
to supporting scripts. It needs only NodeJS and git installed. Simply copy all the files to
your server and run the command "cd path_to_seller && npm ci"

Be sure to set the required configuration parameters in seller.config.
Also note the environment variables which it requires (documented in the config file).

To run: node seller.js


### <u>If you want to use the included watchdog utility:</u>

**Start `seller.js`** (first time: complete the setup checklist below):

```
cd /path/to/seller
nohup ./seller_watchdog.sh >> seller_watchdog.out 2>&1 &
```

- Run it from the directory that holds `seller.js`. The watchdog changes to its own directory anyway, but
  `seller_watchdog.out` is created relative to where you run the command, so `cd` there first.
- `nohup ... &` keeps it running after you log out.
- Within a few seconds `seller_watchdog.out` should show `started seller.js (pid ...)`. A `FATAL:` line
  instead means a preflight check failed and nothing was started — the message says what to fix.

**Check that it's running:**

```
pgrep -af seller_watchdog.sh        # the watchdog: "bash ./seller_watchdog.sh"
pgrep -af "node seller.js"          # the seller itself
cat seller-heartbeat.json           # its latest status; "ts" should be under ~30 seconds old
tail -f seller.log                  # the seller's own output
tail seller_watchdog.out            # the watchdog's messages
cat watchdog_restarts.log           # every restart so far (the file only exists after the first one)
```

**Stop `seller.js`:** stop the watchdog, which stops the seller first.

```
pgrep -f seller_watchdog.sh         # prints the watchdog's pid
kill <that pid>                     # SIGTERM
```

or in one step, if it was started as shown above:

```
pkill -TERM -f "bash ./seller_watchdog.sh"
```

- `kill` returns immediately, but stopping takes up to about 15 seconds (the seller gets `SIGTERM`, then
  `SIGKILL` if it hasn't exited). `seller_watchdog.out` shows `stopped` when it's done.
- Confirm nothing is left: `pgrep -af "node seller.js"` should print nothing.

**Restart `seller.js`** (e.g. after changing `seller.config` or `seller.env`, which are only read at
start): stop it as above, wait for `stopped`, then start it again.

**Don't:**

- **Kill the node process directly** (`kill <node pid>`). The watchdog sees the exit and starts it again
  about 10 seconds later.
- **Kill the watchdog with `kill -9`.** It can't stop the seller first, so the seller keeps running
  unsupervised, and a new watchdog refuses to start until you stop that seller by hand
  (`pkill -TERM -f "node seller.js"`, then check with `pgrep`).
- **Start a second copy** of the watchdog or of `node seller.js` in the same directory. The watchdog
  refuses both, but a copy in a *different* directory or on another machine isn't detected — see
  "NOT HANDLED" below.

**Start at boot** (without systemd), with a crontab line (`crontab -e`):

```
@reboot cd /path/to/seller && nohup ./seller_watchdog.sh >> seller_watchdog.out 2>&1 &
```

Lastly, you should be aware of the scripts recover-refund-key.js and release-lease.js,
which can be helpful in unusual circumstances. Full documentation is at the top of 
each file.

