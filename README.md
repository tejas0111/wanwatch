# Auto-Renewal Keeper Service

Automatic, unattended renewal of Walrus blobs before they expire — without the user needing to sign a transaction every time.

This is the monetizable core of a Walrus blob management platform. The Move contract enables permissionless, trust-minimized renewal execution, and the off-chain keeper ensures blobs stay alive through reliable, low-latency monitoring.

## Architecture

```
auto-renewal-keeper/
├── contracts/       # Move smart contract (Sui)
├── keeper/          # Off-chain keeper worker
├── api/             # REST API service
├── ui/              # React dashboard UI
└── spec.md          # Full technical specification
```

## Quick Start

```bash
# Build and test Move contracts
cd contracts && sui move build && sui move test

# Install API dependencies
cd api && npm install

# Install keeper dependencies
cd keeper && npm install

# Install UI dependencies
cd ui && npm install
```

## Services

| Service | Description | Port |
|---|---|---|
| **API** | REST API for vault CRUD and transaction building | 3001 |
| **Keeper** | Background worker that scans and executes renewals | — |
| **UI** | React dashboard for managing vaults | 5173 |

## Documentation

See [spec.md](./spec.md) for the full technical specification.
