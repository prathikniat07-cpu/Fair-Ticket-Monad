// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Utils} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Utils.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title FairTicket
/// @notice Price-capped NFT tickets whose ownership can only move through the
/// contract's protected resale marketplace.
contract FairTicket is ERC721, Ownable, Pausable, ReentrancyGuard {
    using MessageHashUtils for bytes32;

    uint256 public constant MAX_CHECK_IN_PROOF_LIFETIME = 10 minutes;

    struct Listing {
        address seller;
        uint96 price;
    }

    error ApprovalsDisabled();
    error DirectTransfersDisabled();
    error IncorrectPayment(uint256 expected, uint256 received);
    error InvalidCheckInProof();
    error InvalidConfiguration();
    error InvalidQuantity();
    error InvalidResalePrice(uint256 maximum);
    error NoProceeds();
    error NotListed();
    error NotTicketOwner();
    error OrganizerCannotResell();
    error PayoutFailed();
    error ProofExpired();
    error ProofTooFarInFuture();
    error PurchaseLimitExceeded();
    error SelfPurchase();
    error SoldOut();
    error TicketAlreadyUsed();

    event BaseURIUpdated(string baseTokenURI);
    event PrimaryPurchased(address indexed buyer, uint256 firstTokenId, uint256 quantity, uint256 totalPaid);
    event ResaleCancelled(uint256 indexed tokenId, address indexed seller);
    event ResaleListed(uint256 indexed tokenId, address indexed seller, uint256 price);
    event ResalePurchased(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price);
    event OrganizerProceedsWithdrawn(address indexed organizer, uint256 amount);
    event SellerProceedsWithdrawn(address indexed seller, uint256 amount);
    event TicketCheckedIn(uint256 indexed tokenId, address indexed attendee, address indexed gateOperator);

    string public eventName;
    string public venue;
    uint64 public immutable eventStartsAt;
    uint32 public immutable maxSupply;
    uint16 public immutable maxPerWallet;
    uint16 public immutable resaleMarkupBps;
    uint96 public immutable faceValue;
    uint96 public immutable resaleCap;
    uint32 public totalMinted;
    uint256 public organizerProceeds;

    string private _baseTokenURI;
    bool private _marketTransfer;

    mapping(address account => uint256 quantity) public primaryPurchases;
    mapping(address account => uint256 quantity) public lifetimePurchases;
    mapping(address seller => uint256 amount) public sellerProceeds;
    mapping(uint256 tokenId => Listing listing) public listings;
    mapping(uint256 tokenId => uint96 amountPaid) public acquisitionPrice;
    mapping(uint256 tokenId => uint256 version) public ownershipNonces;
    mapping(uint256 tokenId => bool checkedIn) public used;

    constructor(
        address organizer,
        string memory eventName_,
        string memory venue_,
        uint64 eventStartsAt_,
        uint32 maxSupply_,
        uint16 maxPerWallet_,
        uint96 faceValue_,
        uint16 resaleMarkupBps_,
        string memory baseTokenURI_
    ) ERC721("FairTicket Pass", "FAIR") Ownable(organizer) {
        if (
            organizer == address(0) || bytes(eventName_).length == 0 ||
            bytes(venue_).length == 0 || eventStartsAt_ == 0 ||
            maxSupply_ == 0 || maxPerWallet_ == 0 ||
            maxPerWallet_ > maxSupply_ || faceValue_ == 0 ||
            resaleMarkupBps_ > 10_000 || bytes(baseTokenURI_).length == 0
        ) {
            revert InvalidConfiguration();
        }

        uint256 cap = uint256(faceValue_) + (uint256(faceValue_) * resaleMarkupBps_) / 10_000;
        if (cap > type(uint96).max) revert InvalidConfiguration();

        eventName = eventName_;
        venue = venue_;
        eventStartsAt = eventStartsAt_;
        maxSupply = maxSupply_;
        maxPerWallet = maxPerWallet_;
        faceValue = faceValue_;
        resaleMarkupBps = resaleMarkupBps_;
        resaleCap = uint96(cap);
        _baseTokenURI = baseTokenURI_;
    }

    function buyPrimary(uint256 quantity) external payable whenNotPaused nonReentrant {
        if (quantity == 0) revert InvalidQuantity();
        if (uint256(totalMinted) + quantity > maxSupply) revert SoldOut();
        if (lifetimePurchases[msg.sender] + quantity > maxPerWallet) revert PurchaseLimitExceeded();

        uint256 expected = uint256(faceValue) * quantity;
        if (msg.value != expected) revert IncorrectPayment(expected, msg.value);

        uint256 firstTokenId = uint256(totalMinted) + 1;
        totalMinted += uint32(quantity);
        primaryPurchases[msg.sender] += quantity;
        lifetimePurchases[msg.sender] += quantity;
        organizerProceeds += msg.value;

        for (uint256 tokenId = firstTokenId; tokenId < firstTokenId + quantity; tokenId++) {
            acquisitionPrice[tokenId] = faceValue;
            _safeMint(msg.sender, tokenId);
        }

        emit PrimaryPurchased(msg.sender, firstTokenId, quantity, msg.value);
    }

    function listForResale(uint256 tokenId, uint96 price) external whenNotPaused {
        if (ownerOf(tokenId) != msg.sender) revert NotTicketOwner();
        if (msg.sender == owner()) revert OrganizerCannotResell();
        if (used[tokenId]) revert TicketAlreadyUsed();
        uint96 maximum = maxResalePrice(tokenId);
        if (price == 0 || price > maximum) revert InvalidResalePrice(maximum);

        listings[tokenId] = Listing({seller: msg.sender, price: price});
        emit ResaleListed(tokenId, msg.sender, price);
    }

    function cancelResale(uint256 tokenId) external {
        Listing memory listing = listings[tokenId];
        if (listing.seller == address(0)) revert NotListed();
        if (listing.seller != msg.sender || ownerOf(tokenId) != msg.sender) revert NotTicketOwner();

        delete listings[tokenId];
        emit ResaleCancelled(tokenId, msg.sender);
    }

    function buyResale(uint256 tokenId) external payable whenNotPaused nonReentrant {
        Listing memory listing = listings[tokenId];
        if (listing.seller == address(0)) revert NotListed();
        if (listing.seller == msg.sender) revert SelfPurchase();
        if (ownerOf(tokenId) != listing.seller) revert NotTicketOwner();
        if (used[tokenId]) revert TicketAlreadyUsed();
        if (lifetimePurchases[msg.sender] + 1 > maxPerWallet) revert PurchaseLimitExceeded();
        if (msg.value != listing.price) revert IncorrectPayment(listing.price, msg.value);

        delete listings[tokenId];
        sellerProceeds[listing.seller] += msg.value;
        lifetimePurchases[msg.sender]++;
        acquisitionPrice[tokenId] = listing.price;
        ownershipNonces[tokenId]++;

        _marketTransfer = true;
        _update(msg.sender, tokenId, address(0));
        _marketTransfer = false;
        ERC721Utils.checkOnERC721Received(msg.sender, listing.seller, msg.sender, tokenId, "");

        emit ResalePurchased(tokenId, listing.seller, msg.sender, msg.value);
    }

    /// @notice The highest allowed next resale price for this ticket. The cap
    /// is always calculated from what the current owner actually paid.
    function maxResalePrice(uint256 tokenId) public view returns (uint96) {
        ownerOf(tokenId);
        uint256 paid = acquisitionPrice[tokenId];
        uint256 maximum = paid + (paid * resaleMarkupBps) / 10_000;
        if (maximum > type(uint96).max) return type(uint96).max;
        return uint96(maximum);
    }

    /// @notice Returns the exact 32-byte challenge the current owner must sign.
    function checkInChallenge(uint256 tokenId, uint256 deadline) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                address(this),
                block.chainid,
                tokenId,
                deadline,
                ownerOf(tokenId),
                ownershipNonces[tokenId]
            )
        );
    }

    /// @notice Lets the organizer mark a ticket used only after its current
    /// owner signs a fresh wallet proof for this contract and token.
    function checkIn(uint256 tokenId, uint256 deadline, bytes calldata signature) external onlyOwner whenNotPaused {
        if (block.timestamp > deadline) revert ProofExpired();
        if (deadline > block.timestamp + MAX_CHECK_IN_PROOF_LIFETIME) revert ProofTooFarInFuture();
        if (used[tokenId]) revert TicketAlreadyUsed();

        address attendee = ownerOf(tokenId);
        bytes32 digest = checkInChallenge(tokenId, deadline).toEthSignedMessageHash();
        if (ECDSA.recover(digest, signature) != attendee) revert InvalidCheckInProof();

        used[tokenId] = true;
        delete listings[tokenId];
        emit TicketCheckedIn(tokenId, attendee, msg.sender);
    }

    function withdrawOrganizerProceeds() external onlyOwner nonReentrant {
        uint256 amount = organizerProceeds;
        if (amount == 0) revert NoProceeds();
        organizerProceeds = 0;
        (bool sent,) = payable(owner()).call{value: amount}("");
        if (!sent) revert PayoutFailed();
        emit OrganizerProceedsWithdrawn(owner(), amount);
    }

    function withdrawSellerProceeds() external nonReentrant {
        uint256 amount = sellerProceeds[msg.sender];
        if (amount == 0) revert NoProceeds();
        sellerProceeds[msg.sender] = 0;
        (bool sent,) = payable(msg.sender).call{value: amount}("");
        if (!sent) revert PayoutFailed();
        emit SellerProceedsWithdrawn(msg.sender, amount);
    }

    function ticketsOf(address holder) external view returns (uint256[] memory tokenIds) {
        tokenIds = new uint256[](balanceOf(holder));
        uint256 cursor;
        for (uint256 tokenId = 1; tokenId <= totalMinted; tokenId++) {
            if (_ownerOf(tokenId) == holder) tokenIds[cursor++] = tokenId;
        }
    }

    function ticketDetails(address holder)
        external
        view
        returns (
            uint256[] memory tokenIds,
            bool[] memory checkedIn,
            uint96[] memory listingPrices,
            uint96[] memory purchasePrices,
            uint96[] memory maximumPrices
        )
    {
        uint256 count = balanceOf(holder);
        tokenIds = new uint256[](count);
        checkedIn = new bool[](count);
        listingPrices = new uint96[](count);
        purchasePrices = new uint96[](count);
        maximumPrices = new uint96[](count);

        uint256 cursor;
        for (uint256 tokenId = 1; tokenId <= totalMinted; tokenId++) {
            if (_ownerOf(tokenId) == holder) {
                tokenIds[cursor] = tokenId;
                checkedIn[cursor] = used[tokenId];
                listingPrices[cursor] = listings[tokenId].price;
                purchasePrices[cursor] = acquisitionPrice[tokenId];
                maximumPrices[cursor] = maxResalePrice(tokenId);
                cursor++;
            }
        }
    }

    function activeListings()
        external
        view
        returns (
            uint256[] memory tokenIds,
            address[] memory sellers,
            uint96[] memory prices,
            uint96[] memory maximumPrices
        )
    {
        uint256 count;
        for (uint256 tokenId = 1; tokenId <= totalMinted; tokenId++) {
            if (listings[tokenId].seller != address(0)) count++;
        }

        tokenIds = new uint256[](count);
        sellers = new address[](count);
        prices = new uint96[](count);
        maximumPrices = new uint96[](count);
        uint256 cursor;
        for (uint256 tokenId = 1; tokenId <= totalMinted; tokenId++) {
            Listing memory listing = listings[tokenId];
            if (listing.seller != address(0)) {
                tokenIds[cursor] = tokenId;
                sellers[cursor] = listing.seller;
                prices[cursor] = listing.price;
                maximumPrices[cursor] = maxResalePrice(tokenId);
                cursor++;
            }
        }
    }

    function setBaseURI(string calldata baseTokenURI_) external onlyOwner {
        if (bytes(baseTokenURI_).length == 0) revert InvalidConfiguration();
        _baseTokenURI = baseTokenURI_;
        emit BaseURIUpdated(baseTokenURI_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function approve(address, uint256) public pure override {
        revert ApprovalsDisabled();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert ApprovalsDisabled();
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0) && !_marketTransfer) {
            revert DirectTransfersDisabled();
        }
        return super._update(to, tokenId, auth);
    }
}
