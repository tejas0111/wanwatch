import { Link } from 'react-router-dom';

interface VaultCardProps {
  vault: {
    id: string;
    beneficiary: string;
    blobId: string;
    /** WAL balance in MIST (10^-9 WAL). Raw bigint string from chain. */
    walBalance: string;
    policy: {
      renewThresholdEpochs: number;
      renewByEpochs: number;
      maxTotalEpochs: number | null;
      active: boolean;
    };
    totalRenewals: number;
  };
}

/**
 * Convert a WAL balance from MIST (10^-9) to a human-readable string.
 *
 * Example: "1250000000000" -> "1,250.00 WAL"
 */
function formatWalBalance(mist: string): string {
  const MIST_PER_WAL = 1_000_000_000;
  const value = BigInt(mist || '0');
  const whole = value / BigInt(MIST_PER_WAL);
  const fraction = value % BigInt(MIST_PER_WAL);
  const fractionStr = fraction.toString().padStart(9, '0').slice(0, 2);
  return `${whole.toLocaleString()}.${fractionStr}`;
}

export function VaultCard({ vault }: VaultCardProps) {
  const statusColor = vault.policy.active ? 'bg-green-400' : 'bg-gray-500';
  const displayBalance = formatWalBalance(vault.walBalance);

  return (
    <Link
      to={`/vaults/${vault.id}`}
      className="block p-5 bg-gray-900 border border-gray-800 rounded-xl hover:border-indigo-500/50 transition-all group"
    >
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className={`w-2 h-2 rounded-full ${statusColor}`} />
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">
              {vault.policy.active ? 'Active' : 'Paused'}
            </span>
          </div>
          <h3 className="text-sm font-mono text-gray-300">
            {vault.id.slice(0, 10)}...{vault.id.slice(-6)}
          </h3>
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold text-white">{displayBalance} WAL</div>
          <div className="text-xs text-gray-500">Balance</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 text-sm">
        <div>
          <div className="text-gray-400 text-xs">Renewals</div>
          <div className="text-white font-medium">{vault.totalRenewals}</div>
        </div>
        <div>
          <div className="text-gray-400 text-xs">Threshold</div>
          <div className="text-white font-medium">{vault.policy.renewThresholdEpochs} epochs</div>
        </div>
        <div>
          <div className="text-gray-400 text-xs">Extension</div>
          <div className="text-white font-medium">{vault.policy.renewByEpochs} epochs</div>
        </div>
      </div>

      <div className="mt-4 pt-3 border-t border-gray-800 flex justify-between items-center">
        <span className="text-xs text-gray-500">Blob {vault.blobId.slice(0, 8)}...</span>
        <span className="text-xs text-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity">
          View details →
        </span>
      </div>
    </Link>
  );
}
