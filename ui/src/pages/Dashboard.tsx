import { useCurrentAccount } from '@mysten/dapp-kit';
import { Link } from 'react-router-dom';
import { VaultCard } from '../components/VaultCard';

// Placeholder data — will be replaced with API calls.
// walBalance values are in MIST (10^-9 WAL) as returned by the scanner.
const MOCK_VAULTS = [
  {
    id: '0x1234...abcd',
    beneficiary: '0x...',
    blobId: '0xbeef...cafe',
    walBalance: '1250000000000', // 1250 WAL in MIST
    policy: {
      renewThresholdEpochs: 5,
      renewByEpochs: 30,
      maxTotalEpochs: 365,
      active: true,
    },
    totalRenewals: 12,
  },
  {
    id: '0x5678...ef01',
    beneficiary: '0x...',
    blobId: '0xdead...beef',
    walBalance: '500000000000', // 500 WAL in MIST
    policy: {
      renewThresholdEpochs: 3,
      renewByEpochs: 15,
      maxTotalEpochs: null,
      active: true,
    },
    totalRenewals: 4,
  },
];

export function Dashboard() {
  const account = useCurrentAccount();

  if (!account) {
    return (
      <div className="flex flex-col items-center justify-center py-24">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center mb-6">
          <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-white mb-2">Connect Your Wallet</h2>
        <p className="text-gray-400 text-center max-w-md">
          Connect your Sui wallet to manage your auto-renewal vaults and keep your Walrus blobs alive indefinitely.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header Section */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Your Vaults</h1>
          <p className="text-gray-400 text-sm mt-1">
            Manage auto-renewal policies for your Walrus blobs
          </p>
        </div>
        <Link
          to="/vaults/new"
          className="px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-medium rounded-lg transition-colors"
        >
          + New Vault
        </Link>
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl">
          <div className="text-gray-400 text-sm">Active Vaults</div>
          <div className="text-2xl font-bold text-white mt-1">2</div>
        </div>
        <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl">
          <div className="text-gray-400 text-sm">Total WAL Deposited</div>
          <div className="text-2xl font-bold text-white mt-1">1,750 WAL</div>
        </div>
        <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl">
          <div className="text-gray-400 text-sm">Total Renewals</div>
          <div className="text-2xl font-bold text-white mt-1">16</div>
        </div>
      </div>

      {/* Vault List */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {MOCK_VAULTS.map((vault) => (
          <VaultCard key={vault.id} vault={vault} />
        ))}
      </div>
    </div>
  );
}
