// === Auto-Renewal Keeper — Vault Module ===
//
// On-chain contract for permissionless, trust-minimized auto-renewal
// of Walrus blobs. Users deposit WAL and a Blob object into a RenewalVault,
// set a renewal policy, and anyone (keeper bots) can call execute_renewal
// when the blob is due for renewal, earning a keeper fee.
//
// Full spec: see spec.md §3.1
//
// Walrus Move API used:
//   - system::System       — global system state, epoch tracking
//   - system::extend_blob  — extends a blob's storage by paying WAL
//   - system::epoch        — returns the current epoch
//   - blob::Blob           — the Walrus blob object (held in custody)
//   - blob::end_epoch      — returns the blob's current storage end epoch
//   - blob::blob_id        — returns the blob's u256 identifier
//   - wal::wal::WAL        — the native WAL token type

module auto_renewal::vault {

    // ============================================================================
    // Imports
    // ============================================================================

    use sui::coin::{Self, Coin};
    use sui::balance::{Self, Balance};
    use sui::object::{Self, UID, ID};
    use sui::transfer;
    use sui::tx_context::{Self, TxContext};
    use sui::event;

    use wal::wal::WAL;
    use walrus::blob::{Self, Blob};
    use walrus::system::{Self, System};

    // ============================================================================
    // Constants
    // ============================================================================

    /// Default protocol fee as basis points (400 = 4%).
    /// Can be overridden via FeeConfig.
    const DEFAULT_PROTOCOL_FEE_BPS: u64 = 400;

    /// Minimum keeper fee in MIST-equivalent of WAL.
    /// Paid to whichever address successfully calls execute_renewal.
    const DEFAULT_KEEPER_FEE: u64 = 1_000_000;

    // ============================================================================
    // Error Codes
    // ============================================================================

    /// Caller is not the vault's beneficiary
    const ENotBeneficiary: u64 = 1;
    /// Renewal policy is not active
    const ENotActive: u64 = 2;
    /// Blob is not yet due for renewal
    const ENotDueForRenewal: u64 = 3;
    /// Vault WAL balance is insufficient for the renewal
    const EInsufficientBalance: u64 = 4;
    /// Maximum total epochs safety cap has been reached
    const EPolicyExhausted: u64 = 5;
    /// Blob has already been reclaimed from this vault
    const EBlobNotFound: u64 = 6;
    /// FeeConfig not yet initialized
    const EFeeConfigNotSet: u64 = 7;

    // ============================================================================
    // Structs
    // ============================================================================

    /// Global fee configuration, created in init() and shared.
    public struct FeeConfig has key {
        id: UID,
        /// Address that receives protocol fees
        treasury: address,
        /// Protocol fee in basis points (e.g., 400 = 4%)
        protocol_fee_bps: u64,
        /// Fixed keeper fee paid to the executor
        keeper_fee: u64,
    }

    /// Core vault object — holds the blob and WAL balance for auto-renewal.
    /// One vault per blob (v1 design, see spec §3.3).
    ///
    /// The `blob` field is wrapped in `Option<Blob>` to allow reclaiming:
    /// the beneficiary can call `reclaim_blob` which uses `option::extract`
    /// to move the Blob out of the vault and transfer it back.
    public struct RenewalVault has key {
        id: UID,
        /// The user who controls this vault (withdraw, reclaim, update policy)
        beneficiary: address,
        /// The Walrus Blob object held in custody (None after reclaimed)
        blob: Option<Blob>,
        /// Prepaid WAL balance for funding renewals
        wal_balance: Balance<WAL>,
        /// Renewal policy configuration
        policy: RenewalPolicy,
        /// Total number of successful renewals executed
        total_renewals_executed: u64,
        /// Total protocol fees collected (in MIST-equivalent of WAL)
        total_fees_paid: u64,
        /// Epoch when the vault was created
        created_at_epoch: u64,
    }

    /// Renewal policy controlling when and how much to renew.
    public struct RenewalPolicy has store, copy, drop {
        /// Trigger renewal when <= this many epochs remain on the blob
        renew_threshold_epochs: u64,
        /// How many epochs to extend per renewal call
        renew_by_epochs: u64,
        /// Optional safety cap — stop auto-renewing past this absolute end_epoch
        max_total_epochs: Option<u64>,
        /// Whether the policy is currently active (beneficiary can pause)
        active: bool,
    }

    // ============================================================================
    // Events
    // ============================================================================

    public struct VaultCreated has copy, drop {
        vault_id: ID,
        beneficiary: address,
        blob_id: u256,
        created_at_epoch: u64,
    }

    public struct Deposited has copy, drop {
        vault_id: ID,
        amount: u64,
        depositor: address,
    }

    public struct PolicyUpdated has copy, drop {
        vault_id: ID,
        renew_threshold_epochs: u64,
        renew_by_epochs: u64,
        max_total_epochs: Option<u64>,
        active: bool,
    }

    public struct Withdrawn has copy, drop {
        vault_id: ID,
        amount: u64,
        beneficiary: address,
    }

    public struct BlobReclaimed has copy, drop {
        vault_id: ID,
        blob_id: u256,
        beneficiary: address,
    }

    public struct RenewalExecuted has copy, drop {
        vault_id: ID,
        blob_id: u256,
        new_end_epoch: u32,
        actual_cost: u64,
        protocol_fee_paid: u64,
        keeper_fee_paid: u64,
        executor: address,
    }

    public struct InsufficientBalance has copy, drop {
        vault_id: ID,
        required: u64,
        available: u64,
    }

    public struct PolicyExhausted has copy, drop {
        vault_id: ID,
        blob_id: u256,
        max_total_epochs: u64,
    }

    // ============================================================================
    // Initialization
    // ============================================================================

    /// Initialize the FeeConfig with default values.
    /// The treasury address MUST be set before mainnet deployment.
    fun init(ctx: &mut TxContext) {
        let fee_config = FeeConfig {
            id: object::new(ctx),
            treasury: @0x0,
            protocol_fee_bps: DEFAULT_PROTOCOL_FEE_BPS,
            keeper_fee: DEFAULT_KEEPER_FEE,
        };
        transfer::share_object(fee_config);
    }

    // ============================================================================
    // FeeConfig Administration
    // ============================================================================

    /// Set the treasury address that receives protocol fees.
    public entry fun set_treasury(
        config: &mut FeeConfig,
        new_treasury: address,
    ) {
        config.treasury = new_treasury;
    }

    /// Set the protocol fee in basis points.
    public entry fun set_protocol_fee_bps(
        config: &mut FeeConfig,
        new_fee_bps: u64,
    ) {
        config.protocol_fee_bps = new_fee_bps;
    }

    /// Set the keeper fee.
    public entry fun set_keeper_fee(
        config: &mut FeeConfig,
        new_fee: u64,
    ) {
        config.keeper_fee = new_fee;
    }

    // ============================================================================
    // Entry Functions
    // ============================================================================

    /// Create a new auto-renewal vault, transferring the blob and initial
    /// WAL deposit into the contract's custody.
    public entry fun create_vault(
        blob: Blob,
        initial_wal: Coin<WAL>,
        renew_threshold_epochs: u64,
        renew_by_epochs: u64,
        max_total_epochs: Option<u64>,
        ctx: &mut TxContext
    ) {
        let beneficiary = tx_context::sender(ctx);
        let current_epoch = tx_context::epoch(ctx);
        let blob_id = blob.blob_id();

        let vault = RenewalVault {
            id: object::new(ctx),
            beneficiary,
            blob: option::some(blob),
            wal_balance: coin::into_balance(initial_wal),
            policy: RenewalPolicy {
                renew_threshold_epochs,
                renew_by_epochs,
                max_total_epochs,
                active: true,
            },
            total_renewals_executed: 0,
            total_fees_paid: 0,
            created_at_epoch: current_epoch,
        };

        let vault_id = object::id(&vault);
        transfer::share_object(vault);

        event::emit(VaultCreated {
            vault_id,
            beneficiary,
            blob_id,
            created_at_epoch: current_epoch,
        });
    }

    /// Top up the vault's WAL balance. Anyone can deposit.
    public entry fun deposit(
        vault: &mut RenewalVault,
        coin: Coin<WAL>,
        _ctx: &mut TxContext
    ) {
        let amount = coin::value(&coin);
        balance::join(&mut vault.wal_balance, coin::into_balance(coin));

        event::emit(Deposited {
            vault_id: object::id(vault),
            amount,
            depositor: tx_context::sender(_ctx),
        });
    }

    /// Update the vault's renewal policy. Beneficiary only.
    public entry fun update_policy(
        vault: &mut RenewalVault,
        new_policy: RenewalPolicy,
        ctx: &TxContext
    ) {
        assert!(tx_context::sender(ctx) == vault.beneficiary, ENotBeneficiary);
        vault.policy = new_policy;

        event::emit(PolicyUpdated {
            vault_id: object::id(vault),
            renew_threshold_epochs: vault.policy.renew_threshold_epochs,
            renew_by_epochs: vault.policy.renew_by_epochs,
            max_total_epochs: vault.policy.max_total_epochs,
            active: vault.policy.active,
        });
    }

    /// Withdraw WAL from the vault back to the beneficiary. Beneficiary only.
    public entry fun withdraw(
        vault: &mut RenewalVault,
        amount: u64,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == vault.beneficiary, ENotBeneficiary);
        let withdrawn = coin::take(&mut vault.wal_balance, amount, ctx);
        transfer::public_transfer(withdrawn, vault.beneficiary);

        event::emit(Withdrawn {
            vault_id: object::id(vault),
            amount,
            beneficiary: vault.beneficiary,
        });
    }

    /// Reclaim the Blob object from the vault, cancelling auto-renewal.
    /// Beneficiary only. Transfers the blob back and deactivates the policy.
    public entry fun reclaim_blob(
        vault: &mut RenewalVault,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == vault.beneficiary, ENotBeneficiary);

        // Extract the blob from the Option, aborting if already reclaimed.
        let blob = option::extract(&mut vault.blob);
        let blob_id = blob.blob_id();

        vault.policy.active = false;

        // Transfer the blob back to the beneficiary.
        // Blob has `store` ability, so public_transfer is allowed.
        transfer::public_transfer(blob, vault.beneficiary);

        event::emit(BlobReclaimed {
            vault_id: object::id(vault),
            blob_id,
            beneficiary: vault.beneficiary,
        });
    }

    /// Permissionless — anyone can call this to execute a due renewal.
    public entry fun execute_renewal(
        vault: &mut RenewalVault,
        fee_config: &mut FeeConfig,
        system: &mut System,
        ctx: &mut TxContext
    ) {
        // 1. Policy must be active and blob must exist
        assert!(vault.policy.active, ENotActive);
        assert!(vault.blob.is_some(), EBlobNotFound);

        let current_epoch = system::epoch(system);
        let end_epoch = vault.blob.borrow().end_epoch();

        // 2. Check if renewal is actually due
        assert!(
            (current_epoch as u64) + vault.policy.renew_threshold_epochs >= (end_epoch as u64),
            ENotDueForRenewal,
        );

        // 3. Apply max_total_epochs safety cap
        let mut actual_renew_epochs = vault.policy.renew_by_epochs;

        if (vault.policy.max_total_epochs.is_some()) {
            let max_epochs = *vault.policy.max_total_epochs.borrow();

            if ((end_epoch as u64) + actual_renew_epochs > max_epochs) {
                if (max_epochs <= (end_epoch as u64)) {
                    vault.policy.active = false;
                    event::emit(PolicyExhausted {
                        vault_id: object::id(vault),
                        blob_id: vault.blob.borrow().blob_id(),
                        max_total_epochs: max_epochs,
                    });
                    return;
                };
                actual_renew_epochs = max_epochs - (end_epoch as u64);
            };
        };

        // 4. Compute fees and check balance
        let available = balance::value(&vault.wal_balance);
        let protocol_fee_bps = fee_config.protocol_fee_bps;
        let keeper_fee = fee_config.keeper_fee;
        let treasury = fee_config.treasury;

        let estimated_cost = estimate_renewal_cost(actual_renew_epochs);
        let protocol_fee = (estimated_cost * protocol_fee_bps) / 10000;
        let total_needed = estimated_cost + protocol_fee + keeper_fee;

        if (available < total_needed) {
            event::emit(InsufficientBalance {
                vault_id: object::id(vault),
                required: total_needed,
                available,
            });
            abort EInsufficientBalance
        };

        // 5. Split fees and call extend_blob
        let mut payment_coin = coin::take(&mut vault.wal_balance, total_needed, ctx);

        // Protocol fee to treasury
        let protocol_coin = coin::split(&mut payment_coin, protocol_fee, ctx);
        transfer::public_transfer(protocol_coin, treasury);

        // Keeper fee to executor
        if (keeper_fee > 0) {
            let keeper_coin = coin::split(&mut payment_coin, keeper_fee, ctx);
            transfer::public_transfer(keeper_coin, tx_context::sender(ctx));
        };

        let before_extend = coin::value(&payment_coin);

        // Extend the blob via Walrus system
        system::extend_blob(system, vault.blob.borrow_mut(), actual_renew_epochs as u32, &mut payment_coin);

        let actual_cost = before_extend - coin::value(&payment_coin);

        // Return leftover to vault
        let remaining = coin::into_balance(payment_coin);
        if (balance::value(&remaining) > 0) {
            balance::join(&mut vault.wal_balance, remaining);
        } else {
            remaining.destroy_zero();
        };

        // 6. Update state and emit event
        let new_end_epoch = vault.blob.borrow().end_epoch();

        vault.total_renewals_executed = vault.total_renewals_executed + 1;
        vault.total_fees_paid = vault.total_fees_paid + protocol_fee;

        event::emit(RenewalExecuted {
            vault_id: object::id(vault),
            blob_id: vault.blob.borrow().blob_id(),
            new_end_epoch,
            actual_cost,
            protocol_fee_paid: protocol_fee,
            keeper_fee_paid: keeper_fee,
            executor: tx_context::sender(ctx),
        });
    }

    // ============================================================================
    // View Functions
    // ============================================================================

    /// Check if a vault is active and its blob is due for renewal.
    public fun is_due(vault: &RenewalVault, current_epoch: u32): bool {
        if (!vault.policy.active) return false;
        if (vault.blob.is_none()) return false;
        let end_epoch = vault.blob.borrow().end_epoch();
        (current_epoch as u64) + vault.policy.renew_threshold_epochs >= (end_epoch as u64)
    }

    /// Get the beneficiary address of a vault.
    public fun get_beneficiary(vault: &RenewalVault): address {
        vault.beneficiary
    }

    /// Get the current WAL balance of a vault.
    public fun get_wal_balance(vault: &RenewalVault): u64 {
        balance::value(&vault.wal_balance)
    }

    /// Get the blob ID if the vault still holds a blob.
    public fun get_blob_id(vault: &RenewalVault): Option<u256> {
        if (vault.blob.is_some()) {
            option::some(vault.blob.borrow().blob_id())
        } else {
            option::none()
        }
    }

    /// Get the blob's current storage end epoch, if the blob still exists.
    public fun get_end_epoch(vault: &RenewalVault): Option<u32> {
        if (vault.blob.is_some()) {
            option::some(vault.blob.borrow().end_epoch())
        } else {
            option::none()
        }
    }

    /// Get the current renewal policy.
    public fun get_policy(vault: &RenewalVault): RenewalPolicy {
        vault.policy
    }

    /// Get whether the vault still holds a blob (i.e., hasn't been reclaimed).
    public fun has_blob(vault: &RenewalVault): bool {
        vault.blob.is_some()
    }

    // ============================================================================
    // FeeConfig View Functions
    // ============================================================================

    /// Get the treasury address from FeeConfig.
    public fun treasury_address(config: &FeeConfig): address {
        config.treasury
    }

    /// Get the protocol fee in basis points.
    public fun protocol_fee_bps(config: &FeeConfig): u64 {
        config.protocol_fee_bps
    }

    /// Get the keeper fee.
    public fun keeper_fee(config: &FeeConfig): u64 {
        config.keeper_fee
    }

    // ============================================================================
    // Internal Helpers
    // ============================================================================

    /// Estimate the WAL cost of extending a blob by `epochs` epochs.
    fun estimate_renewal_cost(epochs: u64): u64 {
        epochs * 1_000_000
    }
}
