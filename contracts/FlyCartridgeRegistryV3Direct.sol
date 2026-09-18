// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice Wallet-direct v3 trait publication. Full bytes remain in the publish transaction.
/// @dev Neural semantics are checked by the independent off-chain verifier.
contract FlyCartridgeRegistryV3Direct is ERC721, ReentrancyGuard {
    using Strings for uint256;
    uint32 public constant MAX_MANIFEST_BYTES = 16_384;
    // BSC legacy txpool rejects transactions above 128 KiB, independent of gas.
    // Leave room for ABI encoding, the signature and transaction envelope.
    uint32 public constant MAX_PUBLICATION_BYTES = 120_000;

    struct Card {
        address creator;
        bytes32 stateKey;
        bytes32 parentCardId;
        bytes32 stateSha256;
        uint32 stateLength;
        uint32 manifestLength;
        uint64 publishBlock;
        uint256 tokenId;
    }

    uint256 public immutable deploymentChainId;
    uint256 public nextTokenId = 1;
    mapping(bytes32 => Card) private cards;
    mapping(bytes32 => uint256) public tokenByCardId;
    mapping(bytes32 => uint256) public tokenByStateKey;
    mapping(bytes32 => uint256) public tokenByStateSha256;
    mapping(uint256 => bytes32) public cardIdByToken;

    event Published(bytes32 indexed cardId, uint256 indexed tokenId,
                    address indexed creator, bytes32 stateKey, bytes32 parentCardId,
                    bytes32 stateSha256, uint32 manifestLength, uint32 stateLength);
    error InvalidInput();
    error DuplicateCard();
    error DuplicateState();
    error UnknownParent();

    constructor(uint256 expectedChainId) ERC721("Fly Cartridge V3 Direct", "FLYCT") {
        if (expectedChainId != block.chainid) revert InvalidInput();
        deploymentChainId = expectedChainId;
    }

    function publish(
        bytes calldata manifest,
        bytes calldata state,
        bytes32 stateKey,
        bytes32 parentCardId
    ) external nonReentrant returns (bytes32 cardId, uint256 tokenId) {
        if (block.chainid != deploymentChainId ||
            manifest.length == 0 || manifest.length > MAX_MANIFEST_BYTES ||
            state.length == 0 ||
            manifest.length + state.length > MAX_PUBLICATION_BYTES ||
            stateKey == bytes32(0)) revert InvalidInput();
        cardId = sha256(manifest);
        bytes32 stateSha256 = sha256(state);
        if (cards[cardId].creator != address(0)) revert DuplicateCard();
        if (tokenByStateKey[stateKey] != 0 ||
            tokenByStateSha256[stateSha256] != 0) revert DuplicateState();
        if (parentCardId != bytes32(0) && cards[parentCardId].tokenId == 0) {
            revert UnknownParent();
        }

        tokenId = nextTokenId++;
        cards[cardId] = Card({
            creator: msg.sender, stateKey: stateKey, parentCardId: parentCardId,
            stateSha256: stateSha256, stateLength: uint32(state.length),
            manifestLength: uint32(manifest.length), publishBlock: uint64(block.number),
            tokenId: tokenId
        });
        tokenByCardId[cardId] = tokenId;
        tokenByStateKey[stateKey] = tokenId;
        tokenByStateSha256[stateSha256] = tokenId;
        cardIdByToken[tokenId] = cardId;
        _safeMint(msg.sender, tokenId);
        emit Published(cardId, tokenId, msg.sender, stateKey, parentCardId,
                       stateSha256, uint32(manifest.length), uint32(state.length));
    }

    function card(bytes32 cardId) external view returns (Card memory) {
        return cards[cardId];
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
}
