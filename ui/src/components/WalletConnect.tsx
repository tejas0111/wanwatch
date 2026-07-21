import { useCurrentAccount, useConnectWallet, useDisconnectWallet, useWallets } from '@mysten/dapp-kit';
import { useCallback, useState } from 'react';

export function WalletConnect() {
  const account = useCurrentAccount();
  const wallets = useWallets();
  const { mutate: connect } = useConnectWallet();
  const { mutate: disconnect } = useDisconnectWallet();
  const [showInstallTip, setShowInstallTip] = useState(false);

  const handleConnect = useCallback(() => {
    const wallet = wallets[0];

    if (!wallet) {
      // No wallets detected — show installation guidance
      setShowInstallTip(true);
      setTimeout(() => setShowInstallTip(false), 5000);
      return;
    }

    connect({ wallet });
  }, [wallets, connect]);

  const handleDisconnect = useCallback(() => {
    disconnect();
  }, [disconnect]);

  if (account) {
    return (
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 rounded-lg">
          <div className="w-2 h-2 rounded-full bg-green-400" />
          <span className="text-sm text-gray-300">
            {account.address.slice(0, 6)}...{account.address.slice(-4)}
          </span>
        </div>
        <button
          onClick={handleDisconnect}
          className="px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={handleConnect}
        className="px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-medium rounded-lg transition-colors"
      >
        Connect Wallet
      </button>

      {/* Wallet install tooltip */}
      {showInstallTip && (
        <div className="absolute top-full right-0 mt-2 p-3 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 w-64">
          <p className="text-sm text-gray-200">
            No Sui wallet detected. Install{' '}
            <a
              href="https://chrome.google.com/webstore/detail/sui-wallet/opcgpfmipidbgpenhmajoajpbobppdil"
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-400 hover:text-indigo-300 underline"
            >
              Sui Wallet
            </a>{' '}
            or{' '}
            <a
              href="https://www.suiet.app/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-400 hover:text-indigo-300 underline"
            >
              Suiet
            </a>{' '}
            to connect.
          </p>
        </div>
      )}
    </div>
  );
}
