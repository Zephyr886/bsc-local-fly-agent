// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice Immutable Registry V4 commitments for Profile-aware Fly Cartridges.
/// @dev Full manifest/state bytes stay in publish calldata and are recovered by verified clients.
contract FlyCartridgeRegistryV4 is ERC721, ReentrancyGuard {
    using Strings for uint256;

    uint16 public constant PROFILE_SCHEMA_VERSION = 1;
    uint32 public constant MAX_PROFILE_REVISION = 999_999;
    // MaleCNS v1.0 sampled soma positions, CC BY 4.0. The filename embeds
    // the SHA-256 prefix and the full digest is committed below.
    string public constant COVER_URL =
        "https://flaptofly.com/nft/fly-cartridge-v3-0ec7c8477b27.png";
    bytes32 public constant COVER_SHA256 =
        0x0ec7c8477b27bba1441466c67140bf9e0aadeec06bfa26b1194466b64ca2b9f1;
    uint32 public constant MAX_MANIFEST_BYTES = 32_768;
    // BSC legacy txpool rejects transactions above 128 KiB. Keep envelope headroom.
    uint32 public constant MAX_PUBLICATION_BYTES = 120_000;

    struct Card {
        address creator;
        bytes32 profileHash;
        bytes32 stateKey;
        bytes32 stateSha256;
        address parentRegistry;
        bytes32 parentCardId;
        uint16 profileSchemaVersion;
        uint32 profileRevision;
        uint32 manifestLength;
        uint32 stateLength;
        uint64 publishBlock;
        uint256 tokenId;
    }

    uint256 public immutable deploymentChainId;
    uint256 public nextTokenId = 1;
    mapping(bytes32 => Card) private cards;
    mapping(bytes32 => uint256) public tokenByCardId;
    mapping(bytes32 => uint256) public tokenByContentKey;
    mapping(uint256 => bytes32) public cardIdByToken;

    event Published(
        bytes32 indexed cardId,
        uint256 indexed tokenId,
        address indexed creator,
        bytes32 profileHash,
        bytes32 stateKey,
        bytes32 stateSha256,
        bytes32 contentKey,
        address parentRegistry,
        bytes32 parentCardId,
        uint16 profileSchemaVersion,
        uint32 profileRevision,
        uint32 manifestLength,
        uint32 stateLength
    );

    error InvalidInput();
    error DuplicateCard();
    error DuplicateContent();
    error UnknownLocalParent();

    constructor(uint256 expectedChainId) ERC721("Fly Cartridge V4", "FLYV4") {
        if (expectedChainId != block.chainid) revert InvalidInput();
        deploymentChainId = expectedChainId;
    }

    function contentKey(bytes32 profileHash, bytes32 stateSha256)
        public pure returns (bytes32)
    {
        return sha256(abi.encodePacked(profileHash, stateSha256));
    }

    function publish(
        bytes calldata manifest,
        bytes calldata state,
        bytes32 profileHash,
        bytes32 stateKey,
        address parentRegistry,
        bytes32 parentCardId,
        uint16 profileSchemaVersion,
        uint32 profileRevision
    ) external nonReentrant returns (bytes32 cardId, uint256 tokenId) {
        bool parentEmpty = parentRegistry == address(0) && parentCardId == bytes32(0);
        bool parentSet = parentRegistry != address(0) && parentCardId != bytes32(0);
        if (
            block.chainid != deploymentChainId ||
            manifest.length == 0 || manifest.length > MAX_MANIFEST_BYTES ||
            state.length == 0 || manifest.length + state.length > MAX_PUBLICATION_BYTES ||
            profileHash == bytes32(0) || stateKey == bytes32(0) ||
            profileSchemaVersion != PROFILE_SCHEMA_VERSION ||
            profileRevision == 0 || profileRevision > MAX_PROFILE_REVISION ||
            (!parentEmpty && !parentSet)
        ) revert InvalidInput();

        cardId = sha256(manifest);
        bytes32 stateSha256 = sha256(state);
        bytes32 uniqueContentKey = contentKey(profileHash, stateSha256);
        if (cards[cardId].creator != address(0)) revert DuplicateCard();
        if (tokenByContentKey[uniqueContentKey] != 0) revert DuplicateContent();
        if (parentRegistry == address(this) && cards[parentCardId].tokenId == 0) {
            revert UnknownLocalParent();
        }

        tokenId = nextTokenId++;
        cards[cardId] = Card({
            creator: msg.sender,
            profileHash: profileHash,
            stateKey: stateKey,
            stateSha256: stateSha256,
            parentRegistry: parentRegistry,
            parentCardId: parentCardId,
            profileSchemaVersion: profileSchemaVersion,
            profileRevision: profileRevision,
            manifestLength: uint32(manifest.length),
            stateLength: uint32(state.length),
            publishBlock: uint64(block.number),
            tokenId: tokenId
        });
        tokenByCardId[cardId] = tokenId;
        tokenByContentKey[uniqueContentKey] = tokenId;
        cardIdByToken[tokenId] = cardId;
        _safeMint(msg.sender, tokenId);

        emit Published(
            cardId,
            tokenId,
            msg.sender,
            profileHash,
            stateKey,
            stateSha256,
            uniqueContentKey,
            parentRegistry,
            parentCardId,
            profileSchemaVersion,
            profileRevision,
            uint32(manifest.length),
            uint32(state.length)
        );
    }

    function card(bytes32 cardId) external view returns (Card memory) {
        return cards[cardId];
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        ownerOf(tokenId);
        bytes32 cardId = cardIdByToken[tokenId];
        Card memory item = cards[cardId];
        bytes32 uniqueContentKey = contentKey(item.profileHash, item.stateSha256);
        bytes memory metadata = abi.encodePacked(
            '{"name":"Fly Cartridge V4 ', tokenId.toString(),
            '","description":"Immutable Profile-aware fly cartridge commitments. Cover: MaleCNS v1.0 sampled brain soma positions (CC BY 4.0); the cover is anatomical, not a rendering of this token state.",',
            '"image":"', COVER_URL, '",',
            '"attributes":[{"trait_type":"cardId","value":"',
            Strings.toHexString(uint256(cardId), 32), '"},',
            '{"trait_type":"profileHash","value":"',
            Strings.toHexString(uint256(item.profileHash), 32), '"},',
            '{"trait_type":"stateSha256","value":"',
            Strings.toHexString(uint256(item.stateSha256), 32), '"},',
            '{"trait_type":"contentKey","value":"',
            Strings.toHexString(uint256(uniqueContentKey), 32), '"},',
            '{"trait_type":"coverSha256","value":"',
            Strings.toHexString(uint256(COVER_SHA256), 32), '"}]}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(metadata));
    }
}
