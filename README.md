
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

Be sure to set the required configuration parameters in seller.config.

EvrLight is designed to be quite robust against a variety of errors, and will
automatically unwind most transactions which encounter problems. It also maintains a few
files such as active-seller-addresses.txt and seller-lease-state.json to help it avoid
problems and to automaticaally recover funds at re-start in case of a software or hardware
crash. Nevertheless, the computer on which seller.js and its Lightning node run should be
as robust and secure as possible since they are live Evrmore and Bitcoin wallets.

Lastly, you should be aware of the scripts recover-refund-key.js and release-lease.js,
which can be helpful in unusual circumstances. Full documentation is at the top of 
each file.

