import { useParams, Link } from 'react-router-dom';
import { useCurrentAccount } from '@mysten/dapp-kit';

export function VaultDetail() {
  const { vaultId } = useParams();
  const account = useCurrentAccount();

  if (!account) {
    return (
      <div className="text-center py-24 text-gray-400">
        Connect your wallet to view vault details.
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Back link */}
      <Link to="/" className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors">
        ← Back to Dashboard
      </Link>

      {/* Vault Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Vault Details</h1>
          <p className="text-sm font-mono text-gray-400 mt-1">{vaultId}</p>
        </div>
        <span className="px-3 py-1 bg-green-500/10 text-green-400 text-sm font-medium rounded-full">
          Active
        </span>
      </div>

      {/* Balance & Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl">
          <div className="text-gray-400 text-sm">WAL Balance</div>
          <div className="text-xl font-bold text-white mt-1">1,250 WAL</div>
        </div>
        <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl">
          <div className="text-gray-400 text-sm">Total Renewals</div>
          <div className="text-xl font-bold text-white mt-1">12</div>
        </div>
        <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl">
          <div className="text-gray-400 text-sm">Fees Paid</div>
          <div className="text-xl font-bold text-white mt-1">50 WAL</div>
        </div>
        <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl">
          <div className="text-gray-400 text-sm">Est. Runway</div>
          <div className="text-xl font-bold text-white mt-1">~10 renewals</div>
        </div>
      </div>

      {/* Policy */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Policy</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          <div>
            <div className="text-gray-400 text-xs">Threshold</div>
            <div className="text-white font-medium mt-1">5 epochs</div>
          </div>
          <div>
            <div className="text-gray-400 text-xs">Extension</div>
            <div className="text-white font-medium mt-1">30 epochs</div>
          </div>
          <div>
            <div className="text-gray-400 text-xs">Max Total</div>
            <div className="text-white font-medium mt-1">365 epochs</div>
          </div>
          <div>
            <div className="text-gray-400 text-xs">Status</div>
            <div className="text-green-400 font-medium mt-1">Active</div>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <button className="px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-medium rounded-lg transition-colors">
          Deposit WAL
        </button>
        <button className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-white text-sm font-medium rounded-lg transition-colors">
          Update Policy
        </button>
        <button className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-white text-sm font-medium rounded-lg transition-colors">
          Withdraw
        </button>
        <button className="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 text-sm font-medium rounded-lg transition-colors">
          Reclaim Blob
        </button>
      </div>

      {/* History */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Renewal History</h2>
        <div className="text-gray-500 text-sm text-center py-8">
          No renewal events yet. Events will appear here after the first renewal is executed.
        </div>
      </div>
    </div>
  );
}
