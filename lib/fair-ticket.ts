import {
  createPublicClient,
  defineChain,
  http,
  isAddress,
  parseAbi,
  type Address,
} from "viem";

export const monadTestnet = defineChain({
  id: 10_143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://testnet-rpc.monad.xyz"] },
  },
  blockExplorers: {
    default: {
      name: "MonadScan",
      url: "https://testnet.monadscan.com",
    },
  },
  contracts: {
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11",
      blockCreated: 0,
    },
  },
  testnet: true,
});

export const fairTicketAbi = parseAbi([
  "function owner() view returns (address)",
  "function eventName() view returns (string)",
  "function venue() view returns (string)",
  "function eventStartsAt() view returns (uint64)",
  "function faceValue() view returns (uint96)",
  "function resaleCap() view returns (uint96)",
  "function resaleMarkupBps() view returns (uint16)",
  "function maxSupply() view returns (uint32)",
  "function maxPerWallet() view returns (uint16)",
  "function totalMinted() view returns (uint32)",
  "function organizerProceeds() view returns (uint256)",
  "function sellerProceeds(address seller) view returns (uint256)",
  "function primaryPurchases(address buyer) view returns (uint256)",
  "function lifetimePurchases(address buyer) view returns (uint256)",
  "function acquisitionPrice(uint256 tokenId) view returns (uint96)",
  "function maxResalePrice(uint256 tokenId) view returns (uint96)",
  "function buyPrimary(uint256 quantity) payable",
  "function listForResale(uint256 tokenId, uint96 price)",
  "function cancelResale(uint256 tokenId)",
  "function buyResale(uint256 tokenId) payable",
  "function checkInChallenge(uint256 tokenId, uint256 deadline) view returns (bytes32)",
  "function checkIn(uint256 tokenId, uint256 deadline, bytes signature)",
  "function withdrawOrganizerProceeds()",
  "function withdrawSellerProceeds()",
  "function ticketsOf(address holder) view returns (uint256[] tokenIds)",
  "function ticketDetails(address holder) view returns (uint256[] tokenIds, bool[] checkedIn, uint96[] listingPrices, uint96[] purchasePrices, uint96[] maximumPrices)",
  "function activeListings() view returns (uint256[] tokenIds, address[] sellers, uint96[] prices, uint96[] maximumPrices)",
  "function used(uint256 tokenId) view returns (bool)",
  "function listings(uint256 tokenId) view returns (address seller, uint96 price)",
]);

// Verified FairTicket deployment on Monad Testnet. An environment value can
// override it for future deployments, while the public build remains live by
// default instead of silently falling back to transaction-free demo state.
const DEFAULT_TESTNET_ADDRESS = "0xa076acc389960c75970da41a7b74efa13be05ac4";
const browserAddress = typeof window !== "undefined"
  ? new URLSearchParams(window.location.search).get("contract")
  : undefined;
const rawAddress = browserAddress || process.env.NEXT_PUBLIC_FAIR_TICKET_ADDRESS || DEFAULT_TESTNET_ADDRESS;

export const fairTicketAddress: Address | undefined =
  rawAddress && isAddress(rawAddress) ? rawAddress : undefined;

export const monadPublicClient = createPublicClient({
  chain: monadTestnet,
  transport: http(typeof window === "undefined" ? "https://testnet-rpc.monad.xyz" : "/api/rpc", {
    retryCount: 5,
    retryDelay: 350,
    timeout: 20_000,
  }),
});
