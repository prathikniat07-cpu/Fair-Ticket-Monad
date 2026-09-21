import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("FairTicketModule", (m) => {
  const organizer = m.getAccount(0);
  const eventName = m.getParameter("eventName", "Neon Ragas");
  const venue = m.getParameter("venue", "HITEX Arena, Hyderabad");
  const eventStartsAt = m.getParameter("eventStartsAt", 1_788_012_000n);
  const maxSupply = m.getParameter("maxSupply", 20n);
  const maxPerWallet = m.getParameter("maxPerWallet", 10n);
  const faceValue = m.getParameter("faceValue", 10_000_000_000_000_000n);
  const resaleMarkupBps = m.getParameter("resaleMarkupBps", 1_000n);
  const baseTokenURI = m.getParameter(
    "baseTokenURI",
    "https://fairticket-monad.sujeethsai265.chatgpt.site/api/metadata/",
  );

  const fairTicket = m.contract("FairTicket", [
    organizer,
    eventName,
    venue,
    eventStartsAt,
    maxSupply,
    maxPerWallet,
    faceValue,
    resaleMarkupBps,
    baseTokenURI,
  ]);

  return { fairTicket };
});
