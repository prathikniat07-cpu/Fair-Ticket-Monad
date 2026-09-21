# FairTicket smart contract

The contract mints event tickets at a fixed primary price, disables ordinary
ERC-721 transfers, and permits ownership changes only through its price-capped
resale marketplace. The next resale cap is based on the current owner's
acquisition price, so it can compound across resales. Gate entry requires a ten-minute signature from the
current owner and succeeds only once.

## Install and test

```shell
npm ci
npm test
npm run compile
```

## Testnet deployment

The default module deploys the Neon Ragas demo with 20 tickets, a 0.01 MON
face price, a ten-purchase wallet limit, and a 10% resale markup cap.
The metadata base URL points to the FairTicket website. Review all defaults,
including the event timestamp, in `ignition/modules/FairTicket.ts` before deploying.

Store the funded testnet wallet key in Hardhat's encrypted keystore:

```shell
npx hardhat keystore set PRIVATE_KEY
npm run deploy:testnet
```

Alternatively, set `PRIVATE_KEY` only in the local environment. Never commit a
private key, seed phrase, or keystore password.

Record the deployment transaction, contract address, organizer address, and
constructor parameters. Then update the web app's public deployment address,
rebuild it, and test the buyer, seller, organizer, and gate flows with separate
wallets.

## Operational limitations

This repository is a Monad Testnet hackathon demonstration. Real-value events
also require a cancellation/refund policy, separated treasury and gate roles,
legal review, monitoring, and an independent contract audit.
