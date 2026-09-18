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

On the validated Windows installation, these inputs and the pinned source
produced the following v3 runtime locks. A clean-room rebuild on each OS must
compare against the on-chain manifest; it may not copy an existing graph,
normalized neuron file or checkpoint:

| Derived lock | SHA-256 |
| --- | --- |
| `graph.npz` | `f4d41f011e97e510761d011634891b1c082f61f91463eb586ee9cf8c6371b1d1` |
| `annotations.feather` | `2177e246113e4cfbf1e7772ec37c6da1955ff22e8063d0b1f833101f99a9a3b2` |
| `normalized/neurons.feather` | `0d58f79d637c9cc007ebc971240160ddf5418999f684223685e7837f11bd45ec` |
| kernel source | `6f64247d562483a75f299eef888d0f6595f868b2f9ec904f39ef6cba222bfaa7` |
| rule source | `3c80680450c3b73042e332bd7ce8289d7d74d8695c60e7ac19eefd9759d95c44` |
| runtime source tree | `76a96aedcc589d0648343dd541294ded6738b4a36f9086036fc5a50b559c7768` |

## Remaining release gates

The candidate has no immutable Git tag yet. Clean-room Windows and Linux
rebuilds, independent security review, final-candidate testnet wallet
acceptance and mainnet cost approval remain open. Mainnet deployment is not
part of this release-candidate preparation.
