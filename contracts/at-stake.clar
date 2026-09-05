;; At Stake: did these coins enter a Stacks protocol bond before burn height H?

(define-constant MIN_SNAPSHOT_SATS u1)

(define-constant STATUS_OPEN   u0)
(define-constant STATUS_BONDED u1) ;; YES
(define-constant STATUS_IDLE   u2) ;; NO

(define-constant SIDE_IDLE   u0)
(define-constant SIDE_BONDED u1)

(define-constant ERR_EXISTS             (err u100))
(define-constant ERR_NO_MARKET          (err u101))
(define-constant ERR_NOT_OPEN           (err u102))
(define-constant ERR_WINDOW_CLOSED      (err u103))
(define-constant ERR_WINDOW_OPEN        (err u104))
(define-constant ERR_ZERO               (err u106))
(define-constant ERR_NO_POSITION        (err u107))
(define-constant ERR_UNRESOLVED         (err u108))
(define-constant ERR_BAD_SIDE           (err u109))
(define-constant ERR_SELF_TRANSFER      (err u110))
(define-constant ERR_BAD_THRESHOLD      (err u111))
(define-constant ERR_TITLE_EMPTY        (err u112))
(define-constant ERR_BAD_HEADER         (err u200))
(define-constant ERR_BAD_MERKLE         (err u201))
(define-constant ERR_NO_BURN_BLOCK      (err u202))
(define-constant ERR_SNAPSHOT_TOO_SMALL (err u203))
(define-constant ERR_WRONG_SCRIPT       (err u204))
(define-constant ERR_NOT_SPENT          (err u205))
(define-constant ERR_NO_MEMBERSHIP      (err u206))
(define-constant ERR_NOT_L1             (err u207))
(define-constant ERR_BELOW_THRESHOLD    (err u209))
(define-constant ERR_BOND_TOO_EARLY     (err u210))
(define-constant ERR_BAD_SIG            (err u113))
(define-constant ERR_ORDER_EXPIRED      (err u114))
(define-constant ERR_ORDER_FILLED       (err u115))
(define-constant ERR_ORDER_CANCELLED    (err u116))
(define-constant ERR_FILL_TOO_SMALL     (err u117))
(define-constant ERR_FILL_TOO_LARGE     (err u118))

;; Smallest slice of an order anyone may take. Without a floor, a griefer can
;; chew an order away one share at a time, each nibble costing the book a state
;; write and the seller a fee-bearing settlement.
(define-constant MIN_FILL_BPS u100) ;; 1% of the order

;; Markets are numbered, so a UI can say "#7" instead of a hash.
(define-data-var next-market-id uint u1)

(define-map markets
  { id: uint }
  {
    title:          (string-ascii 64),  ;; a display label, NOT the terms
    subject-script: (buff 34),          ;; scriptPubKey of the wallet in question
    close-height:   uint,               ;; BURN height
    created-at:     uint,               ;; BURN height at creation
    threshold-sats: uint,
    snapshot-sats:  uint,
    status:         uint,
    vault:          uint,               ;; sBTC sats held for this market
    idle-circ:      uint,
    bonded-circ:    uint
  })

;; Same question -> same hash -> the second create is rejected.
(define-map market-by-terms { terms: (buff 32) } { id: uint })

(define-map positions
  { id: uint, who: principal }
  { idle: uint, bonded: uint })

;; Signed orders are one-shot. Filling one records its hash so it cannot be
;; replayed against the seller.
(define-map filled-orders { hash: (buff 32) } { filled: uint })

;; A seller's nonce floor. Orders signed below it are dead, so one transaction
;; revokes every outstanding offer without having to name them.
(define-map order-floor { seller: principal } { min-nonce: uint })

;; Bitcoin block hashes are reported reversed; merkle math is internal order.
(define-private (reverse-buff16 (input (buff 16)))
  (unwrap-panic (slice? (unwrap-panic (to-consensus-buff? (buff-to-uint-le input))) u1 u17)))

(define-read-only (reverse-buff32 (input (buff 32)))
  (unwrap-panic (as-max-len?
    (concat
      (reverse-buff16 (unwrap-panic (as-max-len? (unwrap-panic (slice? input u16 u32)) u16)))
      (reverse-buff16 (unwrap-panic (as-max-len? (unwrap-panic (slice? input u0 u16)) u16))))
    u32)))

(define-read-only (sha256d (data (buff 4096)))
  (sha256 (sha256 data)))

;; A block header is 80 bytes. Bytes 36..68 are the merkle root.
(define-read-only (header-merkle-root (header (buff 80)))
  (slice? header u36 u68))

(define-read-only (merkle-step (cur (buff 32)) (sibling (buff 32)) (right bool))
  (if right
      (sha256d (unwrap-panic (as-max-len? (concat sibling cur) u4096)))
      (sha256d (unwrap-panic (as-max-len? (concat cur sibling) u4096)))))

(define-private (merkle-fold
                  (sibling (buff 32))
                  (acc { hash: (buff 32), idx: uint }))
  { hash: (merkle-step (get hash acc) sibling (is-eq (mod (get idx acc) u2) u1)),
    idx:  (/ (get idx acc) u2) })

(define-read-only (merkle-root-from-proof
                    (leaf (buff 32))
                    (index uint)
                    (path (list 14 (buff 32))))
  (get hash (fold merkle-fold path { hash: leaf, idx: index })))

;; The header is the block at that burn height, and the txid sits under its root.
(define-read-only (tx-was-mined
                    (burn-height uint)
                    (header (buff 80))
                    (txid (buff 32))
                    (tx-index uint)
                    (path (list 14 (buff 32))))
  (let ((chain-hash (unwrap! (get-burn-block-info? header-hash burn-height) ERR_NO_BURN_BLOCK))
        (our-hash   (sha256d (unwrap-panic (as-max-len? header u4096))))
        (root       (unwrap! (header-merkle-root header) ERR_BAD_HEADER)))
    (asserts! (is-eq (reverse-buff32 our-hash) chain-hash) ERR_BAD_HEADER)
    (asserts! (is-eq (merkle-root-from-proof txid tx-index path) root) ERR_BAD_MERKLE)
    (ok true)))

;; The question, hashed. Title is deliberately excluded: renaming a market must
;; not let you open a duplicate of it.
(define-read-only (terms-of (subject-script (buff 34)) (close-height uint) (threshold-sats uint))
  (sha256 (concat (concat subject-script
                          (unwrap-panic (to-consensus-buff? close-height)))
                  (unwrap-panic (to-consensus-buff? threshold-sats)))))

(define-read-only (get-market (id uint))
  (map-get? markets { id: id }))

(define-read-only (get-position (id uint) (who principal))
  (default-to { idle: u0, bonded: u0 } (map-get? positions { id: id, who: who })))

(define-read-only (market-id-for-terms (terms (buff 32)))
  (map-get? market-by-terms { terms: terms }))

(define-read-only (get-next-market-id)
  (var-get next-market-id))

;; Open a market. The snapshot proves the wallet really holds coins; it does not
;; pin which coins must later be bonded.
(define-public (create-market
                 (title (string-ascii 64))
                 (subject-script (buff 34))
                 (close-height uint)
                 (threshold-sats uint)
                 (snap-tx (buff 4096))
                 (snap-vout uint)
                 (burn-height uint)
                 (header (buff 80))
                 (tx-index uint)
                 (merkle-path (list 14 (buff 32))))
  (let ((txid  (contract-call? .btc-parse tx-id snap-tx))
        (terms (terms-of subject-script close-height threshold-sats))
        (id    (var-get next-market-id)))
    (asserts! (> (len title) u0) ERR_TITLE_EMPTY)
    (asserts! (is-none (map-get? market-by-terms { terms: terms })) ERR_EXISTS)
    (asserts! (> close-height burn-block-height) ERR_WINDOW_CLOSED)
    (try! (tx-was-mined burn-height header txid tx-index merkle-path))
    (let ((out (try! (contract-call? .btc-parse get-output snap-tx snap-vout))))
      (asserts! (is-eq (get script out) (unwrap-panic (as-max-len? subject-script u128)))
                ERR_WRONG_SCRIPT)
      (asserts! (>= (get value out) MIN_SNAPSHOT_SATS) ERR_SNAPSHOT_TOO_SMALL)
      ;; A threshold above the coins on offer would make YES unreachable; zero
      ;; would let a dust bond claim it.
      (asserts! (and (> threshold-sats u0) (<= threshold-sats (get value out)))
                ERR_BAD_THRESHOLD)
      (var-set next-market-id (+ id u1))
      (map-set market-by-terms { terms: terms } { id: id })
      (map-set markets { id: id }
        { title: title, subject-script: subject-script, close-height: close-height,
          created-at: burn-block-height, threshold-sats: threshold-sats,
          snapshot-sats: (get value out), status: STATUS_OPEN,
          vault: u0, idle-circ: u0, bonded-circ: u0 })
      (print { event: "create", id: id, title: title, terms: terms,
               snapshot-sats: (get value out), close-height: close-height,
               created-at: burn-block-height })
      (ok id))))

(define-public (mint-complete-set (id uint) (sats uint))
  (let ((m   (unwrap! (map-get? markets { id: id }) ERR_NO_MARKET))
        (pos (get-position id tx-sender)))
    (asserts! (> sats u0) ERR_ZERO)
    (asserts! (is-eq (get status m) STATUS_OPEN) ERR_NOT_OPEN)
    (asserts! (<= burn-block-height (get close-height m)) ERR_WINDOW_CLOSED)
    ;; State first, then the transfer: never leave a window where the books and
    ;; the vault disagree.
    (map-set positions { id: id, who: tx-sender }
             { idle: (+ (get idle pos) sats), bonded: (+ (get bonded pos) sats) })
    (map-set markets { id: id }
             (merge m { vault:       (+ (get vault m) sats),
                        idle-circ:   (+ (get idle-circ m) sats),
                        bonded-circ: (+ (get bonded-circ m) sats) }))
    (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
                          transfer sats tx-sender current-contract none))
    (print { event: "mint", id: id, sats: sats, who: tx-sender })
    (ok sats)))

(define-public (merge-complete-set (id uint) (sats uint))
  (let ((m   (unwrap! (map-get? markets { id: id }) ERR_NO_MARKET))
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
    (try! (as-contract?
            ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token" sats))
            (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
                                  transfer sats current-contract who none))))
    (print { event: "merge", id: id, sats: sats, who: who })
    (ok sats)))

(define-public (transfer-shares (id uint) (side uint) (amount uint) (to principal))
  (let ((m    (unwrap! (map-get? markets { id: id }) ERR_NO_MARKET))
        (from tx-sender)
        (src  (get-position id tx-sender))
        (dst  (get-position id to)))
    (asserts! (> amount u0) ERR_ZERO)
    (asserts! (not (is-eq to from)) ERR_SELF_TRANSFER)
    (asserts! (or (is-eq side SIDE_IDLE) (is-eq side SIDE_BONDED)) ERR_BAD_SIDE)
    (asserts! (is-eq (get status m) STATUS_OPEN) ERR_NOT_OPEN)
    (if (is-eq side SIDE_IDLE)
        (begin
          (asserts! (>= (get idle src) amount) ERR_NO_POSITION)
          (map-set positions { id: id, who: from } (merge src { idle: (- (get idle src) amount) }))
          (map-set positions { id: id, who: to }   (merge dst { idle: (+ (get idle dst) amount) })))
        (begin
          (asserts! (>= (get bonded src) amount) ERR_NO_POSITION)
          (map-set positions { id: id, who: from } (merge src { bonded: (- (get bonded src) amount) }))
          (map-set positions { id: id, who: to }   (merge dst { bonded: (+ (get bonded dst) amount) }))))
    (print { event: "transfer", id: id, side: side, amount: amount, from: from, to: to })
    (ok amount)))

;; What a seller signs. Nothing here is secret: the buyer needs every field to
;; reconstruct the hash, and the signature is what makes it binding.
;; `contract` is a domain separator. Without it a signature is equally valid on
;; any other deployment carrying this function, so an old order could be
;; replayed against a fork or a later version to take shares at a stale price.
(define-read-only (order-hash
                    (id uint) (side uint) (amount uint)
                    (price-sats uint) (nonce uint) (expiry uint))
  (sha256 (unwrap-panic (to-consensus-buff?
    { contract: current-contract, market: id, side: side, amount: amount,
      price: price-sats, nonce: nonce, expiry: expiry }))))

(define-read-only (get-order-floor (seller principal))
  (default-to u0 (get min-nonce (map-get? order-floor { seller: seller }))))

;; Revoke every order signed with a nonce below `min-nonce`. Cheaper and more
;; reliable than cancelling offers one at a time, and it cannot be front-run
;; into a partial state: either the floor moves or it does not.
(define-public (cancel-orders-below (min-nonce uint))
  (begin
    (asserts! (> min-nonce (get-order-floor tx-sender)) ERR_ZERO)
    (map-set order-floor { seller: tx-sender } { min-nonce: min-nonce })
    (print { event: "cancel", seller: tx-sender, min-nonce: min-nonce })
    (ok min-nonce)))

(define-read-only (order-filled (hash (buff 32)))
  (default-to u0 (get filled (map-get? filled-orders { hash: hash }))))

;; What `fill-amount` of an order costs, rounded UP.
;;
;; Floor division is a theft path: 680 sats for 1000 shares makes one share
;; cost (680 * 1 / 1000) = 0, so an order can be taken apart for nothing a
;; share at a time. Rounding up puts the fraction on the buyer, where it
;; belongs.
(define-read-only (fill-price (price-sats uint) (amount uint) (fill-amount uint))
  (if (is-eq amount u0)
      u0
      (/ (+ (* price-sats fill-amount) (- amount u1)) amount)))

;; The smallest slice this order accepts. Always at least one share, and a
;; final remainder is always fillable however small it is -- otherwise the tail
;; of every order would be stranded.
(define-read-only (min-fill-for (amount uint))
  (let ((floor-amt (/ (* amount MIN_FILL_BPS) u10000)))
    (if (> floor-amt u0) floor-amt u1)))

;; Settle an off-chain order on chain, both legs or neither.
;;
;; transfer-shares alone cannot be used to trade with a stranger: it moves
;; shares and nothing else, so somebody has to go first and hope. Here the
;; shares and the sBTC move in one transaction, and the price lands in an event
;; where an indexer can see it -- the contract otherwise has no idea what
;; anything sold for.
;;
;; The book itself stays off chain. This only settles what it matched.
(define-public (fill-order
                 (id uint) (side uint) (amount uint) (price-sats uint)
                 (nonce uint) (expiry uint)
                 (seller principal) (signature (buff 65))
                 (fill-amount uint))
  (let ((m         (unwrap! (map-get? markets { id: id }) ERR_NO_MARKET))
        (hash      (order-hash id side amount price-sats nonce expiry))
        (buyer     tx-sender)
        (src       (get-position id seller))
        (dst       (get-position id tx-sender))
        (already   (order-filled hash))
        (remaining (- amount (order-filled hash)))
        (cost      (fill-price price-sats amount fill-amount)))
    (asserts! (> amount u0) ERR_ZERO)
    (asserts! (> fill-amount u0) ERR_ZERO)
    ;; "nothing left" is a clearer answer than "too much", so check it first
    (asserts! (< already amount) ERR_ORDER_FILLED)
    (asserts! (<= fill-amount remaining) ERR_FILL_TOO_LARGE)
    ;; take at least the minimum, unless you are clearing the tail
    (asserts! (or (>= fill-amount (min-fill-for amount))
                  (is-eq fill-amount remaining))
              ERR_FILL_TOO_SMALL)
    (asserts! (not (is-eq seller buyer)) ERR_SELF_TRANSFER)
    (asserts! (or (is-eq side SIDE_IDLE) (is-eq side SIDE_BONDED)) ERR_BAD_SIDE)
    (asserts! (is-eq (get status m) STATUS_OPEN) ERR_NOT_OPEN)
    (asserts! (<= burn-block-height expiry) ERR_ORDER_EXPIRED)
    (asserts! (>= nonce (get-order-floor seller)) ERR_ORDER_CANCELLED)
    ;; the order is only an order if the seller actually signed it
    (asserts! (is-eq (unwrap! (principal-of? (unwrap! (secp256k1-recover? hash signature)
                                                      ERR_BAD_SIG))
                              ERR_BAD_SIG)
                     seller)
              ERR_BAD_SIG)
    (map-set filled-orders { hash: hash } { filled: (+ already fill-amount) })
    (if (is-eq side SIDE_IDLE)
        (begin
          (asserts! (>= (get idle src) fill-amount) ERR_NO_POSITION)
          (map-set positions { id: id, who: seller } (merge src { idle: (- (get idle src) fill-amount) }))
          (map-set positions { id: id, who: buyer }  (merge dst { idle: (+ (get idle dst) fill-amount) })))
        (begin
          (asserts! (>= (get bonded src) fill-amount) ERR_NO_POSITION)
          (map-set positions { id: id, who: seller } (merge src { bonded: (- (get bonded src) fill-amount) }))
          (map-set positions { id: id, who: buyer }  (merge dst { bonded: (+ (get bonded dst) fill-amount) }))))
    (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
                          transfer cost buyer seller none))
    (print { event: "fill", id: id, side: side, order-amount: amount,
             fill-amount: fill-amount, cost: cost, filled-total: (+ already fill-amount),
             price-sats: price-sats, seller: seller, buyer: buyer, hash: hash })
    (ok fill-amount)))

;; The YES claim. The caller brings evidence and asserts nothing.
;;
;; Two SPV proofs, not one. The funding proof is what makes this a market about
;; a WALLET rather than about a single pre-named coin: it shows the bonded coins
;; came from the subject's own script, whichever UTXO they happened to be.
(define-public (resolve-bonded
                 (id uint)
                 (staker principal)
                 (lockup-tx (buff 4096))
                 (lockup-vout uint)
                 (lockup-burn-height uint)
                 (lockup-header (buff 80))
                 (lockup-tx-index uint)
                 (lockup-path (list 14 (buff 32)))
                 (witness-script (buff 512))
                 (commitment-offset uint)
                 (funding-tx (buff 4096))
                 (funding-vout uint)
                 (funding-burn-height uint)
                 (funding-header (buff 80))
                 (funding-tx-index uint)
                 (funding-path (list 14 (buff 32))))
  (let ((m           (unwrap! (map-get? markets { id: id }) ERR_NO_MARKET))
        (lockup-txid (contract-call? .btc-parse tx-id lockup-tx))
        (funding-txid (contract-call? .btc-parse tx-id funding-tx)))
    ;; 1. still open, still inside the window
    (asserts! (is-eq (get status m) STATUS_OPEN) ERR_NOT_OPEN)
    (asserts! (<= burn-block-height (get close-height m)) ERR_WINDOW_CLOSED)
    ;; 2. the bond has to be news. A lockup that predates the market is a
    ;;    lookup, not a prediction, and the creator would already know it.
    (asserts! (> lockup-burn-height (get created-at m)) ERR_BOND_TOO_EARLY)
    ;; 3. both transactions are really on Bitcoin
    (try! (tx-was-mined lockup-burn-height lockup-header lockup-txid lockup-tx-index lockup-path))
    (try! (tx-was-mined funding-burn-height funding-header funding-txid funding-tx-index funding-path))
    ;; 4. the bonded coins came from this wallet, and the lockup spent them
    (let ((funded (try! (contract-call? .btc-parse get-output funding-tx funding-vout))))
      (asserts! (is-eq (get script funded)
                       (unwrap-panic (as-max-len? (get subject-script m) u128)))
                ERR_WRONG_SCRIPT)
      (asserts! (try! (contract-call? .btc-parse tx-spends-outpoint
                                      lockup-tx funding-txid funding-vout))
                ERR_NOT_SPENT)
      ;; 5. they landed in a P2WSH bound to this staker, above the threshold
      (let ((out (try! (contract-call? .btc-parse get-output lockup-tx lockup-vout))))
        (try! (contract-call? .btc-parse verify-lockup
                              (get script out) (get value out) witness-script
                              staker commitment-offset (get threshold-sats m)))
        ;; 6. and pox-5 agrees this staker holds a live native-L1 bond.
        ;;    Which bond index is deliberately not checked: a staker holds one
        ;;    membership at a time and a rollover rewrites the index, so pinning
        ;;    it would break true outcomes later.
        (let ((mem (unwrap! (contract-call? 'SP000000000000000000002Q6VF78.pox-5
                                            get-bond-membership staker)
                            ERR_NO_MEMBERSHIP)))
          (asserts! (get is-l1-lock mem) ERR_NOT_L1)
          (asserts! (>= (get amount-sats mem) (get threshold-sats m)) ERR_BELOW_THRESHOLD)
          (map-set markets { id: id } (merge m { status: STATUS_BONDED }))
          (print { event: "resolve", id: id, outcome: "bonded", staker: staker,
                   sats: (get amount-sats mem), lockup-burn-height: lockup-burn-height })
          (ok STATUS_BONDED))))))

;; No proof or permission needed: the window simply ran out.
(define-public (resolve-idle (id uint))
  (let ((m (unwrap! (map-get? markets { id: id }) ERR_NO_MARKET)))
    (asserts! (is-eq (get status m) STATUS_OPEN) ERR_NOT_OPEN)
    (asserts! (> burn-block-height (get close-height m)) ERR_WINDOW_OPEN)
    (map-set markets { id: id } (merge m { status: STATUS_IDLE }))
    (print { event: "resolve", id: id, outcome: "idle" })
    (ok STATUS_IDLE)))

(define-public (redeem (id uint))
  (let ((m      (unwrap! (map-get? markets { id: id }) ERR_NO_MARKET))
        (pos    (get-position id tx-sender))
        (who    tx-sender)
        (status (get status m)))
    (asserts! (not (is-eq status STATUS_OPEN)) ERR_UNRESOLVED)
    (let ((payout (if (is-eq status STATUS_BONDED) (get bonded pos) (get idle pos))))
      (asserts! (> payout u0) ERR_NO_POSITION)
      ;; Both sides burn; the loser's shares are worth nothing.
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
