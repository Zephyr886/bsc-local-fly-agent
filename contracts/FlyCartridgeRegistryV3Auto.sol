// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice Experimental v3 trait archive deployed on BSC testnet; not audited for mainnet.
/// @dev Semantic validity of the cartridge is checked by the off-chain reader.
contract FlyCartridgeRegistryV3Auto is ERC721, ReentrancyGuard {
    using Strings for uint256;

    uint32 public constant MAX_MANIFEST_BYTES = 65_536;
    uint32 public constant MAX_STATE_BYTES = 8_388_608;
    uint32 public constant MAX_CHUNK_BYTES = 24_576;
    bytes32 public constant CHUNK_DOMAIN = keccak256("FlyCartridge/v3/chunks");

    struct Card {
        address creator;
        address relay;
        bytes32 stateKey;
        bytes32 parentCardId;
        bytes32 stateSha256;
        bytes32 chunksCommitment;
        uint32 stateLength;
        uint32 uploadedBytes;
        uint32 manifestLength;
        uint64 manifestBlock;
        uint16 chunkCount;
        uint16 received;
        bool finalized;
        bool abandoned;
    }

    struct Chunk {
        bytes32 sha256Digest;
        uint32 length;
        uint64 blockNumber;
    }

    uint256 public immutable deploymentChainId;
    uint256 public nextTokenId = 1;
    mapping(bytes32 => Card) private cards;
    mapping(bytes32 => mapping(uint16 => Chunk)) private chunks;
    mapping(bytes32 => uint256) public tokenByCardId;
    mapping(bytes32 => uint256) public tokenByStateKey;
    mapping(bytes32 => uint256) public tokenByStateSha256;
    mapping(bytes32 => uint256) public tokenByChunksCommitment;
    mapping(uint256 => bytes32) public cardIdByToken;

    event Begun(bytes32 indexed cardId, address indexed creator, bytes32 indexed stateKey,
                bytes32 parentCardId, uint32 manifestLength, uint32 stateLength, uint16 chunkCount);
    event RelayChanged(bytes32 indexed cardId, address indexed relay);
    event ChunkUploaded(bytes32 indexed cardId, uint16 indexed index, bytes32 sha256Digest,
                        uint32 length, uint64 blockNumber);
    event Abandoned(bytes32 indexed cardId);
    event Finalized(bytes32 indexed cardId, uint256 indexed tokenId, address indexed creator,
                    bytes32 stateKey, bytes32 parentCardId);

    error InvalidInput();
    error DuplicateCard();
    error DuplicateState();
    error UnknownParent();
    error WrongCreator();
    error InactiveCard();
    error DuplicateChunk();
    error IncompleteCard();
    error InvalidCommitment();
    error RelayFundingFailed();

    constructor(uint256 expectedChainId) ERC721("Fly Cartridge V3 Auto", "FLYCT") {
        if (expectedChainId != block.chainid) revert InvalidInput();
        deploymentChainId = expectedChainId;
    }

    function begin(
        bytes calldata manifest,
        bytes32 stateKey,
        bytes32 parentCardId,
        bytes32 stateSha256,
        uint32 stateLength,
        bytes32 chunksCommitment,
        address relay
    ) external payable nonReentrant returns (bytes32 cardId) {
        if (block.chainid != deploymentChainId || manifest.length == 0 ||
            manifest.length > MAX_MANIFEST_BYTES || stateKey == bytes32(0) ||
            stateSha256 == bytes32(0) || chunksCommitment == bytes32(0) ||
            stateLength == 0 || stateLength > MAX_STATE_BYTES ||
            relay == address(0) || relay == msg.sender || relay.code.length != 0 ||
            msg.value == 0) revert InvalidInput();
        cardId = sha256(manifest);
        if (cards[cardId].creator != address(0)) revert DuplicateCard();
        if (tokenByStateKey[stateKey] != 0 || tokenByStateSha256[stateSha256] != 0 ||
            tokenByChunksCommitment[chunksCommitment] != 0) {
            revert DuplicateState();
        }
        if (parentCardId != bytes32(0) && !cards[parentCardId].finalized) revert UnknownParent();
        uint16 count = uint16((uint256(stateLength) + MAX_CHUNK_BYTES - 1) / MAX_CHUNK_BYTES);
        cards[cardId] = Card({
            creator: msg.sender, relay: relay, stateKey: stateKey, parentCardId: parentCardId,
            stateSha256: stateSha256, chunksCommitment: chunksCommitment,
            stateLength: stateLength, uploadedBytes: 0,
            manifestLength: uint32(manifest.length), manifestBlock: uint64(block.number),
            chunkCount: count, received: 0, finalized: false, abandoned: false
        });
        emit Begun(cardId, msg.sender, stateKey, parentCardId, uint32(manifest.length), stateLength, count);
        (bool sent,) = relay.call{value: msg.value}("");
        if (!sent) revert RelayFundingFailed();
    }

    /// @notice Rescue an interrupted browser session with a fresh temporary signer.
    function changeRelay(bytes32 cardId, address relay) external payable nonReentrant {
        Card storage card_ = cards[cardId];
        if (card_.creator != msg.sender) revert WrongCreator();
        if (card_.finalized || card_.abandoned || relay == address(0) ||
            relay == msg.sender || relay.code.length != 0) revert InvalidInput();
        card_.relay = relay;
        emit RelayChanged(cardId, relay);
        if (msg.value != 0) {
            (bool sent,) = relay.call{value: msg.value}("");
            if (!sent) revert RelayFundingFailed();
        }
    }

    function upload(bytes32 cardId, uint16 index, bytes calldata data) external {
        Card storage card_ = cards[cardId];
        _requireActive(card_);
        if (index >= card_.chunkCount) revert InvalidInput();
        if (chunks[cardId][index].length != 0) revert DuplicateChunk();
        uint32 expected = index == card_.chunkCount - 1
            ? card_.stateLength - uint32(index) * MAX_CHUNK_BYTES
            : MAX_CHUNK_BYTES;
        if (data.length != expected) revert InvalidInput();
        bytes32 digest = sha256(data);
        chunks[cardId][index] = Chunk(digest, expected, uint64(block.number));
        card_.uploadedBytes += expected;
        card_.received++;
        emit ChunkUploaded(cardId, index, digest, expected, uint64(block.number));
    }

    function finalize(bytes32 cardId) external nonReentrant returns (uint256 tokenId) {
        Card storage card_ = cards[cardId];
        _requireActive(card_);
        if (card_.received != card_.chunkCount || card_.uploadedBytes != card_.stateLength) {
            revert IncompleteCard();
        }
        if (tokenByStateKey[card_.stateKey] != 0 ||
            tokenByStateSha256[card_.stateSha256] != 0 ||
            tokenByChunksCommitment[card_.chunksCommitment] != 0) revert DuplicateState();
        bytes32 rolling = CHUNK_DOMAIN;
        for (uint16 i; i < card_.chunkCount; i++) {
            Chunk storage part = chunks[cardId][i];
            if (part.length == 0) revert IncompleteCard();
            rolling = keccak256(abi.encodePacked(rolling, part.sha256Digest));
        }
        if (rolling != card_.chunksCommitment) revert InvalidCommitment();
        card_.finalized = true;
        tokenId = nextTokenId++;
        tokenByCardId[cardId] = tokenId;
        tokenByStateKey[card_.stateKey] = tokenId;
        tokenByStateSha256[card_.stateSha256] = tokenId;
        tokenByChunksCommitment[card_.chunksCommitment] = tokenId;
        cardIdByToken[tokenId] = cardId;
        _safeMint(card_.creator, tokenId);
        emit Finalized(cardId, tokenId, card_.creator, card_.stateKey, card_.parentCardId);
    }

    function abandon(bytes32 cardId) external {
        Card storage card_ = cards[cardId];
        if (card_.creator != msg.sender) revert WrongCreator();
        if (card_.finalized || card_.abandoned) revert InactiveCard();
        card_.abandoned = true;
        emit Abandoned(cardId);
    }

    function card(bytes32 cardId) external view returns (Card memory) {
        return cards[cardId];
    }

    function chunk(bytes32 cardId, uint16 index) external view returns (Chunk memory) {
        return chunks[cardId][index];
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        ownerOf(tokenId);
        bytes32 cardId = cardIdByToken[tokenId];
        bytes memory metadata = abi.encodePacked(
            '{"name":"Fly Cartridge #', tokenId.toString(),
            '","description":"Immutable on-chain learned fly traits; boots a fresh neural run with the matching open-source runtime.",',
            '"attributes":[{"trait_type":"cardId","value":"',
            Strings.toHexString(uint256(cardId), 32), '"}]}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(metadata));
    }

    function _requireActive(Card storage card_) private view {
        if (card_.relay != msg.sender) revert WrongCreator();
        if (card_.finalized || card_.abandoned) revert InactiveCard();
    }
}
