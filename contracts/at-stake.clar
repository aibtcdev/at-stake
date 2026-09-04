;; At Stake -- one bit per wallet per bond window.
;; "Did these coins enter a Stacks protocol bond before burn height H?"
;;
;; Complete-set market. 1 sat of sBTC mints 1 IDLE + 1 BONDED share.
;; The pair always merges back to 1 sat before resolve, so the two prices
;; must sum to 1. After resolve the winning share redeems 1:1, loser is dust.
;;
;; NO admin key. NO oracle principal. Status is set by exactly two functions,
;; both permissionless, both mechanical.

;; ---------------------------------------------------------------- constants

(define-constant MIN_SNAPSHOT_SATS u100000000) ;; 1 BTC

(define-constant STATUS_OPEN   u0)
(define-constant STATUS_BONDED u1) ;; YES
(define-constant STATUS_IDLE   u2) ;; NO

(define-constant ERR_EXISTS            (err u100))
(define-constant ERR_NO_MARKET         (err u101))
(define-constant ERR_NOT_OPEN          (err u102))
(define-constant ERR_WINDOW_CLOSED     (err u103))
(define-constant ERR_WINDOW_OPEN       (err u104))
(define-constant ERR_BELOW_MIN         (err u105))
(define-constant ERR_ZERO              (err u106))
(define-constant ERR_NO_POSITION       (err u107))
(define-constant ERR_UNRESOLVED        (err u108))
(define-constant SIDE_IDLE   u0)
(define-constant SIDE_BONDED u1)

(define-constant ERR_BAD_SIDE          (err u109))
(define-constant ERR_SELF_TRANSFER     (err u110))
(define-constant ERR_BAD_HEADER        (err u200))
(define-constant ERR_BAD_MERKLE        (err u201))
(define-constant ERR_NO_BURN_BLOCK     (err u202))
(define-constant ERR_SNAPSHOT_TOO_SMALL (err u203))
(define-constant ERR_WRONG_SCRIPT       (err u204))
(define-constant ERR_NOT_SPENT          (err u205))
(define-constant ERR_NO_MEMBERSHIP      (err u206))
(define-constant ERR_NOT_L1             (err u207))
(define-constant ERR_WRONG_BOND         (err u208))
(define-constant ERR_BELOW_THRESHOLD    (err u209))

;; ------------------------------------------------------------------- state

(define-map markets
  { id: (buff 32) }
  {
    script:         (buff 34),  ;; scriptPubKey of the subject wallet
    bond-index:     uint,
    close-height:   uint,       ;; BURN height. bond start, not the reg cutoff.
    threshold-sats: uint,
    snapshot-sats:  uint,       ;; total sats committed at create
    status:         uint,
    vault:          uint,       ;; sBTC sats held for this market
    idle-circ:      uint,
    bonded-circ:    uint
  })

;; The exact coins the question is about. Committed once, at create.
(define-map snapshots
  { id: (buff 32), txid: (buff 32), vout: uint }
  { sats: uint })

(define-map positions
  { id: (buff 32), who: principal }
  { idle: uint, bonded: uint })

;; ------------------------------------------------------- bitcoin: spv layer

;; Bitcoin hashes everything twice.
(define-read-only (sha256d (data (buff 4096)))
  (sha256 (sha256 data)))

;; A block header is 80 bytes. Bytes 36..68 are the merkle root.
(define-read-only (header-merkle-root (header (buff 80)))
  (slice? header u36 u68))

;; One rung of the merkle ladder. `bit` says which side our hash sits on.
(define-read-only (merkle-step (cur (buff 32)) (sibling (buff 32)) (right bool))
  (if right
      (sha256d (unwrap-panic (as-max-len? (concat sibling cur) u4096)))
      (sha256d (unwrap-panic (as-max-len? (concat cur sibling) u4096)))))

;; Walk the proof from the leaf up. `path` is the sibling list, `index` is the
;; leaf's position in the block -- its low bit tells us left/right at each rung.
(define-read-only (merkle-root-from-proof
                    (leaf (buff 32))
                    (index uint)
                    (path (list 14 (buff 32))))
  (get hash
    (fold merkle-fold path { hash: leaf, idx: index })))

(define-private (merkle-fold
                  (sibling (buff 32))
                  (acc { hash: (buff 32), idx: uint }))
  {
    hash: (merkle-step (get hash acc) sibling (is-eq (mod (get idx acc) u2) u1)),
    idx:  (/ (get idx acc) u2)
  })

;; The whole Bitcoin-side check, in one place:
;;   1. the header we were handed really is the block at that burn height
;;   2. the txid really sits under that header's merkle root
(define-read-only (tx-was-mined
                    (burn-height uint)
                    (header (buff 80))
                    (txid (buff 32))
                    (tx-index uint)
                    (path (list 14 (buff 32))))
  (let ((chain-hash (unwrap! (get-burn-block-info? header-hash burn-height)
                             ERR_NO_BURN_BLOCK))
        (our-hash   (sha256d (unwrap-panic (as-max-len? header u4096))))
        (root       (unwrap! (header-merkle-root header) ERR_BAD_HEADER)))
    ;; Stacks stores the header hash; anyone can hand us 80 bytes, so we prove
    ;; the bytes hash to what the chain already agreed on.
    (asserts! (is-eq our-hash chain-hash) ERR_BAD_HEADER)
    (asserts! (is-eq (merkle-root-from-proof txid tx-index path) root) ERR_BAD_MERKLE)
    (ok true)))

;; ------------------------------------------------------------ market: reads

(define-read-only (get-market (id (buff 32)))
  (map-get? markets { id: id }))

(define-read-only (get-position (id (buff 32)) (who principal))
  (default-to { idle: u0, bonded: u0 }
    (map-get? positions { id: id, who: who })))

(define-read-only (get-snapshot-utxo (id (buff 32)) (txid (buff 32)) (vout uint))
  (map-get? snapshots { id: id, txid: txid, vout: vout }))

;; The 68c number. Only meaningful once shares have actually traded; a bare
;; mint is 50/50 and the UI should say so rather than print a fake price.
(define-read-only (implied-idle-price (id (buff 32)))
  (match (map-get? markets { id: id })
    m (let ((total (+ (get idle-circ m) (get bonded-circ m))))
        (if (is-eq total u0)
            none
            (some (/ (* (get bonded-circ m) u10000) total))))
    none))

;; ---------------------------------------------------------- market: writes

(define-public (mint-complete-set (id (buff 32)) (sats uint))
  (let ((m (unwrap! (map-get? markets { id: id }) ERR_NO_MARKET))
        (pos (get-position id tx-sender)))
    (asserts! (> sats u0) ERR_ZERO)
    (asserts! (is-eq (get status m) STATUS_OPEN) ERR_NOT_OPEN)
    (asserts! (<= burn-block-height (get close-height m)) ERR_WINDOW_CLOSED)
    ;; sBTC in, both shares out. Vault always equals complete sets outstanding.
    (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
                          transfer sats tx-sender current-contract none))
    (map-set positions { id: id, who: tx-sender }
             { idle: (+ (get idle pos) sats), bonded: (+ (get bonded pos) sats) })
    (map-set markets { id: id }
             (merge m { vault:       (+ (get vault m) sats),
                        idle-circ:   (+ (get idle-circ m) sats),
                        bonded-circ: (+ (get bonded-circ m) sats) }))
    (ok sats)))

(define-public (merge-complete-set (id (buff 32)) (sats uint))
  (let ((m (unwrap! (map-get? markets { id: id }) ERR_NO_MARKET))
        (pos (get-position id tx-sender))
        (who tx-sender))
    (asserts! (> sats u0) ERR_ZERO)
    (asserts! (is-eq (get status m) STATUS_OPEN) ERR_NOT_OPEN)
    (asserts! (and (>= (get idle pos) sats) (>= (get bonded pos) sats)) ERR_NO_POSITION)
    (map-set positions { id: id, who: who }
             { idle: (- (get idle pos) sats), bonded: (- (get bonded pos) sats) })
    (map-set markets { id: id }
             (merge m { vault:       (- (get vault m) sats),
                        idle-circ:   (- (get idle-circ m) sats),
                        bonded-circ: (- (get bonded-circ m) sats) }))
    ;; Clarity 4+: the contract may move exactly `sats` of sBTC and nothing else.
    ;; If the callee tries to move more, the whole thing rolls back.
    (as-contract?
      ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" sats))
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
                            transfer sats current-contract who none)))))

;; ---------------------------------------------------------- market: create

;; Commit one snapshot UTXO. Proves, on chain, that this outpoint exists, is
;; confirmed on Bitcoin, and pays the script this market is about. Nobody has
;; to be trusted about the wallet's contents.
(define-public (create-market
                 (id (buff 32))
                 (script (buff 34))
                 (bond-index uint)
                 (close-height uint)
                 (threshold-sats uint)
                 (snap-tx (buff 4096))
                 (snap-vout uint)
                 (burn-height uint)
                 (header (buff 80))
                 (tx-index uint)
                 (merkle-path (list 14 (buff 32))))
  (let ((txid (contract-call? .btc-parse tx-id snap-tx)))
    (asserts! (is-none (map-get? markets { id: id })) ERR_EXISTS)
    (asserts! (> close-height burn-block-height) ERR_WINDOW_CLOSED)
    ;; 1. the transaction really is in that Bitcoin block
    (try! (tx-was-mined burn-height header txid tx-index merkle-path))
    ;; 2. the named output really pays this market's wallet
    (let ((out (try! (contract-call? .btc-parse get-output snap-tx snap-vout))))
      (asserts! (is-eq (get script out) (unwrap-panic (as-max-len? script u128)))
                ERR_WRONG_SCRIPT)
      ;; 3. the cutoff lives in the contract, not the domain name
      (asserts! (>= (get value out) MIN_SNAPSHOT_SATS) ERR_SNAPSHOT_TOO_SMALL)
      (map-set snapshots { id: id, txid: txid, vout: snap-vout }
               { sats: (get value out) })
      (map-set markets { id: id }
        { script: script, bond-index: bond-index, close-height: close-height,
          threshold-sats: threshold-sats, snapshot-sats: (get value out),
          status: STATUS_OPEN, vault: u0, idle-circ: u0, bonded-circ: u0 })
      (print { event: "create", id: id, snapshot-sats: (get value out),
               close-height: close-height, bond-index: bond-index })
      (ok id))))

;; ------------------------------------------------------- market: resolve YES

;; The whole claim, checked in one place. The caller supplies evidence; they
;; assert nothing. A forged proof fails at step 2, a lookalike script fails at
;; step 4, an sBTC bond fails at step 6.
(define-public (resolve-bonded
                 (id (buff 32))
                 (staker principal)
                 (lockup-tx (buff 4096))
                 (lockup-vout uint)
                 (burn-height uint)
                 (header (buff 80))
                 (tx-index uint)
                 (merkle-path (list 14 (buff 32)))
                 (witness-script (buff 512))
                 (commitment-offset uint)
                 (snap-txid (buff 32))
                 (snap-vout uint))
  (let ((m (unwrap! (map-get? markets { id: id }) ERR_NO_MARKET))
        (txid (contract-call? .btc-parse tx-id lockup-tx)))
    ;; 1. still open, still inside the window
    (asserts! (is-eq (get status m) STATUS_OPEN) ERR_NOT_OPEN)
    (asserts! (<= burn-block-height (get close-height m)) ERR_WINDOW_CLOSED)
    ;; 2. the lockup transaction is real and confirmed on Bitcoin
    (try! (tx-was-mined burn-height header txid tx-index merkle-path))
    ;; 3. it spends coins this market committed to at create time.
    ;;    This is the step pox-5 does not do, and the only reason a market
    ;;    can be about a Bitcoin wallet at all.
    (asserts! (is-some (map-get? snapshots { id: id, txid: snap-txid, vout: snap-vout }))
              ERR_NOT_SPENT)
    (asserts! (try! (contract-call? .btc-parse tx-spends-outpoint
                                    lockup-tx snap-txid snap-vout))
              ERR_NOT_SPENT)
    ;; 4. the coins landed in a P2WSH bound to this staker, above the threshold
    (let ((out (try! (contract-call? .btc-parse get-output lockup-tx lockup-vout))))
      (try! (contract-call? .btc-parse verify-lockup
                            (get script out) (get value out) witness-script
                            staker commitment-offset (get threshold-sats m)))
      ;; 5. and pox-5 agrees this staker holds a live bond
      (let ((mem (unwrap! (contract-call? 'SP000000000000000000002Q6VF78.pox-5
                                          get-bond-membership staker)
                          ERR_NO_MEMBERSHIP)))
        ;; 6. native L1, not the bridged sBTC path
        (asserts! (get is-l1-lock mem) ERR_NOT_L1)
        (asserts! (is-eq (get bond-index mem) (get bond-index m)) ERR_WRONG_BOND)
        (asserts! (>= (get amount-sats mem) (get threshold-sats m)) ERR_BELOW_THRESHOLD)
        (map-set markets { id: id } (merge m { status: STATUS_BONDED }))
        (print { event: "resolve", id: id, outcome: "bonded", staker: staker,
                 sats: (get amount-sats mem) })
        (ok STATUS_BONDED)))))

;; Shares are ledger rows, not tokens: Clarity cannot spawn a token pair per
;; market, and a contract per wallet is unaffordable. This is what lets someone
;; sell the side they do not believe, which is the only reason a price exists.
(define-public (transfer-shares (id (buff 32)) (side uint) (amount uint) (to principal))
  (let ((m (unwrap! (map-get? markets { id: id }) ERR_NO_MARKET))
        (from tx-sender)
        (src (get-position id tx-sender))
        (dst (get-position id to)))
    (asserts! (> amount u0) ERR_ZERO)
    (asserts! (not (is-eq to from)) ERR_SELF_TRANSFER)
    (asserts! (or (is-eq side SIDE_IDLE) (is-eq side SIDE_BONDED)) ERR_BAD_SIDE)
    (asserts! (is-eq (get status m) STATUS_OPEN) ERR_NOT_OPEN)
    (if (is-eq side SIDE_IDLE)
        (begin
          (asserts! (>= (get idle src) amount) ERR_NO_POSITION)
          (map-set positions { id: id, who: from }
                   (merge src { idle: (- (get idle src) amount) }))
          (map-set positions { id: id, who: to }
                   (merge dst { idle: (+ (get idle dst) amount) })))
        (begin
          (asserts! (>= (get bonded src) amount) ERR_NO_POSITION)
          (map-set positions { id: id, who: from }
                   (merge src { bonded: (- (get bonded src) amount) }))
          (map-set positions { id: id, who: to }
                   (merge dst { bonded: (+ (get bonded dst) amount) }))))
    ;; circulating supply is unchanged: a transfer moves shares, it does not
    ;; mint or burn. The vault invariant must survive this untouched.
    (print { event: "transfer", id: id, side: side, amount: amount, from: from, to: to })
    (ok amount)))

;; No proof, no permission, no key: the window simply ran out.
(define-public (resolve-idle (id (buff 32)))
  (let ((m (unwrap! (map-get? markets { id: id }) ERR_NO_MARKET)))
    (asserts! (is-eq (get status m) STATUS_OPEN) ERR_NOT_OPEN)
    (asserts! (> burn-block-height (get close-height m)) ERR_WINDOW_OPEN)
    (map-set markets { id: id } (merge m { status: STATUS_IDLE }))
    (ok STATUS_IDLE)))

(define-public (redeem (id (buff 32)))
  (let ((m (unwrap! (map-get? markets { id: id }) ERR_NO_MARKET))
        (pos (get-position id tx-sender))
        (who tx-sender)
        (status (get status m)))
    (asserts! (not (is-eq status STATUS_OPEN)) ERR_UNRESOLVED)
    (let ((payout (if (is-eq status STATUS_BONDED) (get bonded pos) (get idle pos))))
      (asserts! (> payout u0) ERR_NO_POSITION)
      ;; Both sides burn. The loser's shares are simply worth nothing.
      (map-set positions { id: id, who: who } { idle: u0, bonded: u0 })
      (map-set markets { id: id }
               (merge m { vault:       (- (get vault m) payout),
                          idle-circ:   (- (get idle-circ m) (get idle pos)),
                          bonded-circ: (- (get bonded-circ m) (get bonded pos)) }))
      (try! (as-contract?
              ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" payout))
              (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
                                    transfer payout current-contract who none))))
      (ok payout))))
