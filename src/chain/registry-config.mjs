function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const CARTRIDGE_V3_LIMITS = deepFreeze({
  maxManifestBytes: 16_384,
  maxPublicationBytes: 120_000,
});

export const BSC_MAINNET_CHAIN_ID = 56;

export const MAINNET_V3_REGISTRIES = deepFreeze({
  auto: {
    id: "v3-auto",
    chainId: BSC_MAINNET_CHAIN_ID,
    contractType: "auto",
    contractName: "FlyCartridgeRegistryV3Auto",
    address: null,
    availability: "legacy-testnet-only",
    artifact: "artifacts/fly-cartridge-v3-auto.json",
    reader: { kind: "chunked-calldata", image: false },
  },
  direct: {
    id: "v3-direct",
    chainId: BSC_MAINNET_CHAIN_ID,
    contractType: "direct",
    contractName: "FlyCartridgeRegistryV3Direct",
    address: "0x8a318b90ae7ce6c3c55dd5f596e16c1623c2c46a",
    availability: "historical-mainnet",
    artifact: "artifacts/fly-cartridge-v3-direct-candidate.json",
    reader: { kind: "single-publish-calldata", image: false },
  },
  image: {
    id: "v3-image",
    chainId: BSC_MAINNET_CHAIN_ID,
    contractType: "image",
    contractName: "FlyCartridgeRegistryV3Image",
    address: "0x7c35e97e8f89eeb2586db4031c13c63d4bd6ca21",
    availability: "active-mainnet",
    artifact: "artifacts/fly-cartridge-v3-image-candidate.json",
    reader: { kind: "single-publish-calldata", image: true },
  },
});

export const ACTIVE_MAINNET_V3_REGISTRY = MAINNET_V3_REGISTRIES.image;
