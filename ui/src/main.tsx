/// <reference types="vite/client" />

import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SuiClientProvider, WalletProvider } from '@mysten/dapp-kit';

import { Dashboard } from './pages/Dashboard';
import { VaultCreate } from './pages/VaultCreate';
import { VaultDetail } from './pages/VaultDetail';
import { Layout } from './components/Layout';

import './index.css';

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider
        networks={{
          testnet: {
            url: import.meta.env.VITE_SUI_RPC_URL || 'https://fullnode.testnet.sui.io:443',
          },
        }}
        defaultNetwork="testnet"
      >
        <WalletProvider>
          <BrowserRouter>
            <Routes>
              <Route element={<Layout />}>
                <Route path="/" element={<Dashboard />} />
                <Route path="/vaults/new" element={<VaultCreate />} />
                <Route path="/vaults/:vaultId" element={<VaultDetail />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
