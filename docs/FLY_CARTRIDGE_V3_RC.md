# FlyCartridge v3 release candidate record

2026-09-18. This is a candidate specification and build record, not a mainnet
release or an audit conclusion. The historical testnet NFT remains readable
with `artifacts/fly-cartridge-v3-auto.json`.

## Product and wire format

- A cartridge represents learned neural traits, not a game, market, wallet or
  device session. The three lossless arrays are `memory_u`, `memory_w` and
  `weight`; a fresh run starts at cursor 0 with learning enabled.
- `formatVersion` is 3, the binary magic is
  `FLY-CARTRIDGE-TRAIT-3\n`, and the identity domain is
  `FlyCartridge/v3/trait\0`. Canonical JSON and SHA-256 bind the manifest,
  state, field values and shared runtime. The trait key also binds the fresh
  boot semantics and shared runtime locks.
- New exports use `locksVersion=2`: graph array values and normalized neuron
  transmitter values are verified against source-controlled content hashes.
  ZIP and Feather container bytes can differ across OS/library versions.
  The verifier accepts the exact historical testnet file hashes only after
  validating the same canonical graph arrays and neuron values. The v3 state
  encoding itself is unchanged; the manifest and Card ID change on re-export.
- The Python verifier accepts at most 16,384 manifest bytes and 262,144 state
  bytes. The on-chain contract can hold more, so clients must enforce the
  stricter v3 profile. Chunks are at most 24,576 bytes each. Export verifies
  the old checkpoint provenance, while import rebuilds the locked baseline
  and runs the fixed 10 ms boot probe.
- The first public version charges BNB Gas only; it has no official-token
  publication fee. Parent IDs remain in the contract wire format, but the
  first public UI will not present parent lineage. These decisions were
  confirmed by the product owner on 2026-09-18.
- The v3 format, reader, builder and contract are published under
  `LICENSE-FLY-CARTRIDGE-V3`. MaleCNS inputs are downloaded separately under
  their own CC BY 4.0 terms; vendored Stonkfly retains its own MIT license.

## Rebuild inputs

Install with `npm ci`. Solidity compiler: `solc` 0.8.37; OpenZeppelin
Contracts: 5.6.1. Optimizer is enabled with 200 runs, and `viaIR` is true.
Run `npm run cartridge:v3:build-check` to prove that the tracked candidate
artifact matches these dependencies and this source byte for byte.

| Input | SHA-256 |
| --- | --- |
| `contracts/FlyCartridgeRegistryV3Auto.sol` | `ea241f1af589796d78df29a7a13ed1e5aeb9a794b0258817d9c44e78a07626ec` |
| Candidate compiled artifact | `874ee38e2f6791e195a2cd7c66b6d5d55196b2fc8eea132e4ca69ed39cb26128` |
| Historical testnet artifact | `4140c66d540115f125f04796c9e8f9cfe92307d74d2b3c351628ad311f45b27f` |

The candidate and historical testnet bytecode have the same ABI and executable
logic, but different Solidity metadata. They are different runtime bytecodes.
The final testnet acceptance must deploy the candidate and lock its exact
runtime bytecode; do not use the historical address as evidence for it.

Raw MaleCNS v1.0 sources and their URLs, byte lengths and SHA-256 values are
fixed in `vendor/stonkfly/stonkfly/neural/sources.lock.json`:

| Raw file | Bytes | SHA-256 |
| --- | ---: | --- |
| `annotations.feather` | 14,483,314 | `2177e246113e4cfbf1e7772ec37c6da1955ff22e8063d0b1f833101f99a9a3b2` |
| `neurotransmitters.feather` | 43,282,834 | `95c9289220663abeb3409f3ad9e5a7f8a53f8093f5139d15502cd08da8879621` |
| `edges.feather` | 1,051,241,946 | `e35da783d1c686b2b58b3b87cd6a403ae43bfcfba8bff28e08ef752c1a56afc1` |

New v3 exports use the following content locks. A clean-room rebuild on each
OS must compare against the on-chain manifest; it may not copy an existing
graph, normalized neuron file or checkpoint:

| Derived lock | SHA-256 |
| --- | --- |
| graph array contents | `a40e7390aa0aad9f055d3f2d40b751ee795c680fae55ba22a3e1480250c23eef` |
| `annotations.feather` | `2177e246113e4cfbf1e7772ec37c6da1955ff22e8063d0b1f833101f99a9a3b2` |
| normalized transmitter values | `6b97946b6f0304bf15f6128ca08bf39c7d863180fd59ae14afc3ca1ac6818fe6` |
| kernel source | `6f64247d562483a75f299eef888d0f6595f868b2f9ec904f39ef6cba222bfaa7` |
| rule source | `3c80680450c3b73042e332bd7ce8289d7d74d8695c60e7ac19eefd9759d95c44` |
| runtime source tree | `76a96aedcc589d0648343dd541294ded6738b4a36f9086036fc5a50b559c7768` |

The historical testnet manifest locked Windows container hashes
`f4d41f011e97e510761d011634891b1c082f61f91463eb586ee9cf8c6371b1d1`
(`graph.npz`) and
`0d58f79d637c9cc007ebc971240160ddf5418999f684223685e7837f11bd45ec`
(`normalized/neurons.feather`). The Linux clean-room graph file SHA-256 was
`346b8af85a11af13b8324e18669812c1924569e7d1adcb4e6f45cc461a2c344b`
while every graph array passed the same lock. The first candidate tag
`v3.0.0-rc.1` therefore failed cross-system verification; this fix belongs
in the next candidate tag and must be retested from public source.

In a diagnostic run with the patched verifier, the old testnet card and a
new content-locked candidate both passed on Windows and Linux. The new
candidate retained the exact 85,942-byte state SHA-256
`9bfc048f7a5633b0695033f01f520fbd35a3806e670d03f55a462ffe65c57614`,
while its manifest produced Card ID
`733eeebd382d1f23b4f1650634abdb9f825f0e016ae82074734fecdb658b4450`.
Both devices installed this candidate with cursor 0 and learning enabled;
the real controller reached cursor 100 with post-memory SHA-256
`f1ec132eac20f1ba072ea9bbaae9a3a9430c2765b9b75f500a5cbf62a97d9488`.
The new Card ID is a local candidate and has not been published on-chain.

## Remaining release gates

The `v3.0.0-rc.1` tag is historical and failed the Linux clean-room gate.
The corrected candidate requires its own tag and clean-room retest.
Independent security review, final-candidate testnet wallet acceptance and
mainnet cost approval remain open. Mainnet deployment is not part of this
release-candidate preparation.
