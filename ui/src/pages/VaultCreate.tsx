import { useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';

export function VaultCreate() {
  const account = useCurrentAccount();
  const [form, setForm] = useState({
    blobId: '',
    initialWalAmount: '',
    renewThresholdEpochs: 5,
    renewByEpochs: 30,
    maxTotalEpochs: '',
    active: true,
  });

  if (!account) {
    return (
      <div className="text-center py-24 text-gray-400">
        Connect your wallet to create a vault.
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // TODO: call API to build unsigned tx, then user signs with wallet
    console.log('Create vault:', form);
  };

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold text-white mb-2">New Auto-Renewal Vault</h1>
      <p className="text-gray-400 mb-8">
        Deposit a Walrus blob and WAL tokens to enable automatic, unattended renewal.
      </p>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Blob ID */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Blob ID
          </label>
          <input
            type="text"
            value={form.blobId}
            onChange={(e) => setForm({ ...form, blobId: e.target.value })}
            placeholder="0x..."
            className="w-full px-4 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>

        {/* Initial WAL Amount */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Initial WAL Deposit
          </label>
          <input
            type="text"
            value={form.initialWalAmount}
            onChange={(e) => setForm({ ...form, initialWalAmount: e.target.value })}
            placeholder="1000"
            className="w-full px-4 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>

        {/* Renewal Policy */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
          <h3 className="text-lg font-semibold text-white">Renewal Policy</h3>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Trigger Threshold (epochs)
              </label>
              <input
                type="number"
                value={form.renewThresholdEpochs}
                onChange={(e) => setForm({ ...form, renewThresholdEpochs: parseInt(e.target.value) })}
                min={1}
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-indigo-500 focus:outline-none"
              />
              <p className="text-xs text-gray-500 mt-1">Renew when ≤ this many epochs remain</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Extension Amount (epochs)
              </label>
              <input
                type="number"
                value={form.renewByEpochs}
                onChange={(e) => setForm({ ...form, renewByEpochs: parseInt(e.target.value) })}
                min={1}
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white focus:border-indigo-500 focus:outline-none"
              />
              <p className="text-xs text-gray-500 mt-1">Epochs to add per renewal</p>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Max Total Epochs <span className="text-gray-500">(optional)</span>
            </label>
            <input
              type="text"
              value={form.maxTotalEpochs}
              onChange={(e) => setForm({ ...form, maxTotalEpochs: e.target.value })}
              placeholder="Unlimited"
              className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
            />
            <p className="text-xs text-gray-500 mt-1">Safety cap — stop renewing past this absolute end epoch</p>
          </div>
        </div>

        {/* Submit */}
        <button
          type="submit"
          className="w-full px-6 py-3 bg-indigo-500 hover:bg-indigo-600 text-white font-medium rounded-lg transition-colors"
        >
          Build Transaction
        </button>

        <p className="text-xs text-gray-500 text-center">
          Your wallet will be asked to sign the transaction. The server never has access to your keys.
        </p>
      </form>
    </div>
  );
}
