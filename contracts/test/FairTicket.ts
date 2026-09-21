import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseEther } from "viem";

const FACE_VALUE = parseEther("0.01");
const RESALE_CAP = parseEther("0.011");
const MAX_TICKETS_PER_WALLET = 10n;

describe("FairTicket", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [organizer, buyer, reseller, attacker] = await viem.getWalletClients();

  async function deploy() {
    const contract = await viem.deployContract("FairTicket", [
      organizer.account.address,
      "Neon Ragas",
      "HITEX Arena, Hyderabad",
      1_788_012_000n,
      20,
      Number(MAX_TICKETS_PER_WALLET),
      FACE_VALUE,
      1_000,
      "https://fairticket.test/metadata/",
    ]);

    const asBuyer = await viem.getContractAt("FairTicket", contract.address, {
      client: { wallet: buyer },
    });
    const asReseller = await viem.getContractAt("FairTicket", contract.address, {
      client: { wallet: reseller },
    });
    const asAttacker = await viem.getContractAt("FairTicket", contract.address, {
      client: { wallet: attacker },
    });

    return { contract, asBuyer, asReseller, asAttacker };
  }

  it("calculates and exposes the immutable fair-price rules", async function () {
    const { contract } = await deploy();
    assert.equal(await contract.read.faceValue(), FACE_VALUE);
    assert.equal(await contract.read.resaleCap(), RESALE_CAP);
    assert.equal(await contract.read.maxPerWallet(), Number(MAX_TICKETS_PER_WALLET));
  });

  it("mints primary tickets only for the exact price and within the wallet limit", async function () {
    const { contract, asBuyer, asReseller } = await deploy();

    await asBuyer.write.buyPrimary([MAX_TICKETS_PER_WALLET], { value: FACE_VALUE * MAX_TICKETS_PER_WALLET });
    assert.equal((await contract.read.ownerOf([1n])).toLowerCase(), buyer.account.address.toLowerCase());
    assert.equal((await contract.read.ownerOf([10n])).toLowerCase(), buyer.account.address.toLowerCase());
    assert.equal(await contract.read.organizerProceeds(), FACE_VALUE * MAX_TICKETS_PER_WALLET);

    await viem.assertions.revertWithCustomError(
      asBuyer.write.buyPrimary([1n], { value: FACE_VALUE }),
      contract,
      "PurchaseLimitExceeded",
    );
    await viem.assertions.revertWithCustomError(
      asReseller.write.buyPrimary([1n], { value: FACE_VALUE + 1n }),
      contract,
      "IncorrectPayment",
    );
  });

  it("enforces the primary limit for the wallet's lifetime, even after resale", async function () {
    const { contract, asBuyer, asReseller } = await deploy();

    await asBuyer.write.buyPrimary([MAX_TICKETS_PER_WALLET], { value: FACE_VALUE * MAX_TICKETS_PER_WALLET });
    await asBuyer.write.listForResale([1n, FACE_VALUE]);
    await asReseller.write.buyResale([1n], { value: FACE_VALUE });

    assert.equal(await contract.read.lifetimePurchases([buyer.account.address]), MAX_TICKETS_PER_WALLET);
    await viem.assertions.revertWithCustomError(
      asBuyer.write.buyPrimary([1n], { value: FACE_VALUE }),
      contract,
      "PurchaseLimitExceeded",
    );
  });

  it("blocks ordinary ERC-721 transfers and over-cap listings", async function () {
    const { contract, asBuyer } = await deploy();
    await asBuyer.write.buyPrimary([1n], { value: FACE_VALUE });

    await viem.assertions.revertWithCustomError(
      asBuyer.write.transferFrom([buyer.account.address, reseller.account.address, 1n]),
      contract,
      "DirectTransfersDisabled",
    );
    await viem.assertions.revertWithCustomError(
      asBuyer.write.listForResale([1n, RESALE_CAP + 1n]),
      contract,
      "InvalidResalePrice",
    );
  });

  it("prevents the organizer from reselling tickets", async function () {
    const { contract } = await deploy();
    await contract.write.buyPrimary([1n], { value: FACE_VALUE });

    await viem.assertions.revertWithCustomError(
      contract.write.listForResale([1n, FACE_VALUE]),
      contract,
      "OrganizerCannotResell",
    );
  });

  it("moves ownership only through a price-capped resale and credits the seller", async function () {
    const { contract, asBuyer, asReseller } = await deploy();
    const resalePrice = parseEther("0.0108");
    await asBuyer.write.buyPrimary([1n], { value: FACE_VALUE });
    await asBuyer.write.listForResale([1n, resalePrice]);

    await asReseller.write.buyResale([1n], { value: resalePrice });
    assert.equal((await contract.read.ownerOf([1n])).toLowerCase(), reseller.account.address.toLowerCase());
    assert.equal(await contract.read.sellerProceeds([buyer.account.address]), resalePrice);
    assert.equal(await contract.read.acquisitionPrice([1n]), resalePrice);
    assert.equal(await contract.read.maxResalePrice([1n]), (resalePrice * 11n) / 10n);
    assert.deepEqual(await contract.read.listings([1n]), [
      "0x0000000000000000000000000000000000000000",
      0n,
    ]);
  });

  it("limits all lifetime purchases, including protected resales, to ten", async function () {
    const { contract, asBuyer, asReseller } = await deploy();
    await asBuyer.write.buyPrimary([1n], { value: FACE_VALUE });
    await asBuyer.write.listForResale([1n, FACE_VALUE]);
    await asReseller.write.buyPrimary([MAX_TICKETS_PER_WALLET], {
      value: FACE_VALUE * MAX_TICKETS_PER_WALLET,
    });

    await viem.assertions.revertWithCustomError(
      asReseller.write.buyResale([1n], { value: FACE_VALUE }),
      contract,
      "PurchaseLimitExceeded",
    );
  });

  it("requires the current owner's fresh wallet signature before gate check-in", async function () {
    const { contract, asBuyer } = await deploy();
    await asBuyer.write.buyPrimary([1n], { value: FACE_VALUE });

    const latestBlock = await publicClient.getBlock();
    const deadline = latestBlock.timestamp + 600n;
    const challenge = await contract.read.checkInChallenge([1n, deadline]);
    const invalidSignature = await attacker.signMessage({ message: { raw: challenge } });

    await viem.assertions.revertWithCustomError(
      contract.write.checkIn([1n, deadline, invalidSignature]),
      contract,
      "InvalidCheckInProof",
    );

    const validSignature = await buyer.signMessage({ message: { raw: challenge } });
    await contract.write.checkIn([1n, deadline, validSignature]);
    assert.equal(await contract.read.used([1n]), true);

    await viem.assertions.revertWithCustomError(
      asBuyer.write.listForResale([1n, FACE_VALUE]),
      contract,
      "TicketAlreadyUsed",
    );
  });

  it("rejects check-in proofs that last longer than ten minutes", async function () {
    const { contract, asBuyer } = await deploy();
    await asBuyer.write.buyPrimary([1n], { value: FACE_VALUE });

    const latestBlock = await publicClient.getBlock();
    const deadline = latestBlock.timestamp + 1_200n;
    const challenge = await contract.read.checkInChallenge([1n, deadline]);
    const signature = await buyer.signMessage({ message: { raw: challenge } });

    await viem.assertions.revertWithCustomError(
      contract.write.checkIn([1n, deadline, signature]),
      contract,
      "ProofTooFarInFuture",
    );
  });

  it("invalidates an old proof when ownership leaves and returns to the same wallet", async function () {
    const { contract, asBuyer, asReseller } = await deploy();
    await asBuyer.write.buyPrimary([1n], { value: FACE_VALUE });

    const latestBlock = await publicClient.getBlock();
    const deadline = latestBlock.timestamp + 600n;
    const oldChallenge = await contract.read.checkInChallenge([1n, deadline]);
    const oldSignature = await buyer.signMessage({ message: { raw: oldChallenge } });

    await asBuyer.write.listForResale([1n, FACE_VALUE]);
    await asReseller.write.buyResale([1n], { value: FACE_VALUE });
    await asReseller.write.listForResale([1n, FACE_VALUE]);
    await asBuyer.write.buyResale([1n], { value: FACE_VALUE });

    assert.equal(await contract.read.ownershipNonces([1n]), 2n);
    await viem.assertions.revertWithCustomError(
      contract.write.checkIn([1n, deadline, oldSignature]),
      contract,
      "InvalidCheckInProof",
    );
  });

  it("allows organizers and sellers to withdraw their recorded proceeds", async function () {
    const { contract, asBuyer, asReseller } = await deploy();

    await asBuyer.write.buyPrimary([1n], { value: FACE_VALUE });
    assert.equal(await contract.read.organizerProceeds(), FACE_VALUE);
    await contract.write.withdrawOrganizerProceeds();
    assert.equal(await contract.read.organizerProceeds(), 0n);

    await asBuyer.write.listForResale([1n, RESALE_CAP]);
    await asReseller.write.buyResale([1n], { value: RESALE_CAP });
    assert.equal(await contract.read.sellerProceeds([buyer.account.address]), RESALE_CAP);
    await asBuyer.write.withdrawSellerProceeds();
    assert.equal(await contract.read.sellerProceeds([buyer.account.address]), 0n);
  });
});
