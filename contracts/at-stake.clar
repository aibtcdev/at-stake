(define-constant MIN_SNAPSHOT_SATS u1)

(define-constant MIN_WINDOW_BLOCKS u144)

(define-constant STATUS_OPEN   u0)
(define-constant STATUS_BONDED u1)
(define-constant STATUS_IDLE   u2)

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
(define-constant ERR_WINDOW_TOO_SHORT   (err u119))
(define-constant ERR_FLOOR_NOT_FORWARD  (err u120))
(define-constant ERR_PARSE              (err u300))
(define-constant ERR_TOO_MANY           (err u302))
(define-constant ERR_NOT_A_LOCKUP       (err u313))
(define-constant ERR_NO_BOND            (err u211))
(define-constant ERR_UNLOCK_TOO_EARLY   (err u212))
(define-constant ERR_WINDOW_TOO_LONG    (err u121))
(define-constant ERR_NOT_A_SNAPSHOT    (err u122))
(define-constant ERR_SNAPSHOT_TOO_LATE (err u123))
(define-constant ERR_SNAPSHOT_EXISTS   (err u124))

(define-constant MIN_FILL_BPS u100)

(define-data-var next-market-id uint u1)

(define-map markets
  { id: uint }
  {
    title:          (string-ascii 64),
    subject-script: (buff 34),
    bond-index:     uint,
    close-height:   uint,
    created-at:     uint,
    threshold-sats: uint,
    snapshot-sats:  uint,
    status:         uint,
    vault:          uint,
    idle-circ:      uint,
    bonded-circ:    uint
  })

(define-map market-by-terms { terms: (buff 32) } { id: uint })

(define-map snapshots { id: uint, txid: (buff 32), vout: uint } { sats: uint })

(define-map positions
  { id: uint, who: principal }
  { idle: uint, bonded: uint })

(define-map filled-orders { hash: (buff 32) } { filled: uint })

(define-map order-floor { seller: principal } { min-nonce: uint })

(define-constant POX5 'SP000000000000000000002Q6VF78.pox-5)

(define-constant MAX_INPUTS u24)
(define-constant IDX (list
  u0  u1  u2  u3  u4  u5  u6  u7  u8  u9  u10 u11
  u12 u13 u14 u15 u16 u17 u18 u19 u20 u21 u22 u23))

(define-read-only (read-u8 (tx (buff 16384)) (pos uint))
  (match (element-at? tx pos)
    b (some (buff-to-uint-be b))
    none))

(define-read-only (read-u32-le (tx (buff 16384)) (pos uint))
  (match (slice? tx pos (+ pos u4))
    b (match (as-max-len? b u16) bb (some (buff-to-uint-le bb)) none)
    none))

;; Bitcoin compact-size integer: the value, and how many bytes it used.
(define-read-only (read-varint (tx (buff 16384)) (pos uint))
  (match (read-u8 tx pos)
    first
      (if (< first u253)
          (some { val: first, size: u1 })
          (if (is-eq first u253)
              (match (slice? tx (+ pos u1) (+ pos u3))
                b (match (as-max-len? b u16) bb (some { val: (buff-to-uint-le bb), size: u3 }) none)
                none)
              (if (is-eq first u254)
                  (match (slice? tx (+ pos u1) (+ pos u5))
                    b (match (as-max-len? b u16) bb (some { val: (buff-to-uint-le bb), size: u5 }) none)
                    none)
                  (match (slice? tx (+ pos u1) (+ pos u9))
                    b (match (as-max-len? b u16) bb (some { val: (buff-to-uint-le bb), size: u9 }) none)
                    none))))
    none))

;; Walk one input: txid(32) vout(4) varint scriptlen, script, sequence(4).
(define-private (skip-input
                  (i uint)
                  (acc { tx: (buff 16384), pos: uint, n: uint, ok: bool,
                         hits: uint, want-txid: (buff 32), want-vout: uint }))
  (if (or (not (get ok acc)) (>= i (get n acc)))
      acc
      (let ((tx (get tx acc))
            (p  (get pos acc)))
        (match (slice? tx p (+ p u32))
          prev-raw
            (match (read-u32-le tx (+ p u32))
              vout
                (match (read-varint tx (+ p u36))
                  vi
                    (let ((next (+ p u36 (get size vi) (get val vi) u4))
                          (matched (and (is-eq (unwrap-panic (as-max-len? prev-raw u32))
                                               (get want-txid acc))
                                        (is-eq vout (get want-vout acc)))))
                      (merge acc { pos: next,
                                   hits: (if matched (+ (get hits acc) u1) (get hits acc)) }))
                  (merge acc { ok: false }))
              (merge acc { ok: false }))
          (merge acc { ok: false })))))

(define-read-only (tx-spends-outpoint
                    (tx (buff 16384))
                    (prev-txid (buff 32))
                    (prev-vout uint))
  (match (read-varint tx u4)
    vin-count
      (if (> (get val vin-count) MAX_INPUTS)
          ERR_TOO_MANY
          (let ((r (fold skip-input IDX
                     { tx: tx, pos: (+ u4 (get size vin-count)),
                       n: (get val vin-count), ok: true, hits: u0,
                       want-txid: prev-txid, want-vout: prev-vout })))
            (if (get ok r) (ok (> (get hits r) u0)) ERR_PARSE)))
    ERR_PARSE))

;; Is this txid in a block Bitcoin actually mined?
(define-private (tx-was-mined
                    (burn-height uint)
                    (header (buff 80))
                    (reversed-txid (buff 32))
                    (tx-index uint)
                    (tx-count uint)
                    (hashes (list 14 (buff 32))))
  (let ((block (unwrap! (contract-call? POX5 parse-block-header header) ERR_BAD_HEADER)))
    (asserts! (contract-call? POX5 verify-block-header header burn-height) ERR_BAD_HEADER)
    (asserts! (or
                ;; sole transaction in the block
                (is-eq (get merkle-root block)
                       (contract-call? POX5 reverse-buff32 reversed-txid))
                (verify-merkle-proof reversed-txid
                  (contract-call? POX5 reverse-buff32 (get merkle-root block))
                  tx-index tx-count hashes))
              ERR_BAD_MERKLE)
    (ok true)))

(define-read-only (terms-of (subject-script (buff 34)) (bond-index uint)
                            (close-height uint) (threshold-sats uint))
  (sha256 (concat (concat subject-script (unwrap-panic (to-consensus-buff? bond-index)))
                  (concat (unwrap-panic (to-consensus-buff? close-height))
                          (unwrap-panic (to-consensus-buff? threshold-sats))))))

(define-read-only (get-market (id uint))
  (map-get? markets { id: id }))

(define-read-only (get-position (id uint) (who principal))
  (default-to { idle: u0, bonded: u0 } (map-get? positions { id: id, who: who })))

(define-read-only (market-id-for-terms (terms (buff 32)))
  (map-get? market-by-terms { terms: terms }))

(define-read-only (get-next-market-id)
  (var-get next-market-id))

(define-read-only (get-snapshot (id uint) (txid (buff 32)) (vout uint))
  (map-get? snapshots { id: id, txid: txid, vout: vout }))

(define-public (create-market
                 (title (string-ascii 64))
                 (subject-script (buff 34))
                 (bond-index uint)
                 (close-height uint)
                 (threshold-sats uint)
                 (snap-tx (buff 16384))
                 (snap-vout uint)
                 (burn-height uint)
                 (header (buff 80))
                 (tx-index uint)
                 (tx-count uint)
                 (merkle-path (list 14 (buff 32))))
  (let ((out   (unwrap! (get-bitcoin-tx-output? snap-tx snap-vout) ERR_PARSE))
        (terms (terms-of subject-script bond-index close-height threshold-sats))
        (id    (var-get next-market-id)))
    (asserts! (> (len title) u0) ERR_TITLE_EMPTY)
    (asserts! (is-none (map-get? market-by-terms { terms: terms })) ERR_EXISTS)
    (asserts! (>= close-height (+ burn-block-height MIN_WINDOW_BLOCKS)) ERR_WINDOW_TOO_SHORT)
    ;; the window must close before this period's coins unlock
    (asserts! (< close-height (contract-call? POX5 get-bond-l1-unlock-height bond-index))
              ERR_WINDOW_TOO_LONG)
    (try! (tx-was-mined burn-height header (get txid out) tx-index tx-count merkle-path))
    (begin
      (asserts! (is-eq (get script out) subject-script) ERR_WRONG_SCRIPT)
      (asserts! (>= (get amount out) MIN_SNAPSHOT_SATS) ERR_SNAPSHOT_TOO_SMALL)
      ;; a threshold above the snapshot can never be met
      (asserts! (and (> threshold-sats u0) (<= threshold-sats (get amount out)))
                ERR_BAD_THRESHOLD)
      (var-set next-market-id (+ id u1))
      (map-set market-by-terms { terms: terms } { id: id })
      (map-set snapshots { id: id, txid: (get txid out), vout: snap-vout }
               { sats: (get amount out) })
      (map-set markets { id: id }
        { title: title, subject-script: subject-script, bond-index: bond-index,
          close-height: close-height,
          created-at: burn-block-height, threshold-sats: threshold-sats,
          snapshot-sats: (get amount out), status: STATUS_OPEN,
          vault: u0, idle-circ: u0, bonded-circ: u0 })
      (print { event: "create", id: id, title: title, terms: terms, bond-index: bond-index,
               snapshot-sats: (get amount out), close-height: close-height,
               created-at: burn-block-height })
      (ok id))))

;; Commit another of the wallet's coins to this market. Permissionless, and
;; only for coins that already existed when the market opened.
(define-public (add-snapshot
                 (id uint)
                 (snap-tx (buff 16384))
                 (snap-vout uint)
                 (burn-height uint)
                 (header (buff 80))
                 (tx-index uint)
                 (tx-count uint)
                 (merkle-path (list 14 (buff 32))))
  (let ((m   (unwrap! (map-get? markets { id: id }) ERR_NO_MARKET))
        (out (unwrap! (get-bitcoin-tx-output? snap-tx snap-vout) ERR_PARSE)))
    (asserts! (is-eq (get status m) STATUS_OPEN) ERR_NOT_OPEN)
    ;; a coin mined after the question was asked is not part of the snapshot
    (asserts! (<= burn-height (get created-at m)) ERR_SNAPSHOT_TOO_LATE)
    (asserts! (is-none (map-get? snapshots { id: id, txid: (get txid out), vout: snap-vout }))
              ERR_SNAPSHOT_EXISTS)
    (try! (tx-was-mined burn-height header (get txid out) tx-index tx-count merkle-path))
    (asserts! (is-eq (get script out) (get subject-script m)) ERR_WRONG_SCRIPT)
    (asserts! (> (get amount out) u0) ERR_SNAPSHOT_TOO_SMALL)
    (map-set snapshots { id: id, txid: (get txid out), vout: snap-vout }
             { sats: (get amount out) })
    (map-set markets { id: id }
             (merge m { snapshot-sats: (+ (get snapshot-sats m) (get amount out)) }))
    (print { event: "snapshot", id: id, txid: (get txid out), vout: snap-vout,
             sats: (get amount out) })
    (ok (get amount out))))

(define-public (mint-complete-set (id uint) (sats uint))
  (let ((m   (unwrap! (map-get? markets { id: id }) ERR_NO_MARKET))
        (pos (get-position id tx-sender)))
    (asserts! (> sats u0) ERR_ZERO)
    (asserts! (is-eq (get status m) STATUS_OPEN) ERR_NOT_OPEN)
    (asserts! (<= burn-block-height (get close-height m)) ERR_WINDOW_CLOSED)
    ;; write state before the transfer
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
    ;; no trading past the deadline: the outcome is already known
    (asserts! (<= burn-block-height (get close-height m)) ERR_WINDOW_CLOSED)
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

(define-read-only (order-hash
                    (seller principal) (id uint) (side uint) (amount uint)
                    (price-sats uint) (nonce uint) (expiry uint))
  (sha256 (unwrap-panic (to-consensus-buff?
    { contract: current-contract, seller: seller, market: id, side: side,
      amount: amount, price: price-sats, nonce: nonce, expiry: expiry }))))

(define-read-only (get-order-floor (seller principal))
  (default-to u0 (get min-nonce (map-get? order-floor { seller: seller }))))

(define-public (cancel-orders-below (min-nonce uint))
  (begin
    (asserts! (> min-nonce (get-order-floor tx-sender)) ERR_FLOOR_NOT_FORWARD)
    (map-set order-floor { seller: tx-sender } { min-nonce: min-nonce })
    (print { event: "cancel", seller: tx-sender, min-nonce: min-nonce })
    (ok min-nonce)))

(define-read-only (order-filled (hash (buff 32)))
  (default-to u0 (get filled (map-get? filled-orders { hash: hash }))))

;; Cost of a partial fill, rounded up.
(define-read-only (fill-price (price-sats uint) (amount uint) (fill-amount uint))
  (if (is-eq amount u0)
      u0
      (/ (+ (* price-sats fill-amount) (- amount u1)) amount)))

(define-read-only (min-fill-for (amount uint))
  (let ((floor-amt (/ (* amount MIN_FILL_BPS) u10000)))
    (if (> floor-amt u0) floor-amt u1)))

(define-public (fill-order
                 (id uint) (side uint) (amount uint) (price-sats uint)
                 (nonce uint) (expiry uint)
                 (seller principal) (signature (buff 65))
                 (fill-amount uint))
  (let ((m         (unwrap! (map-get? markets { id: id }) ERR_NO_MARKET))
        (hash      (order-hash seller id side amount price-sats nonce expiry))
        (buyer     tx-sender)
        (src       (get-position id seller))
        (dst       (get-position id tx-sender))
        (already   (order-filled hash))
        (remaining (- amount (order-filled hash)))
        (cost      (fill-price price-sats amount fill-amount)))
    (asserts! (> amount u0) ERR_ZERO)
    (asserts! (> fill-amount u0) ERR_ZERO)
    (asserts! (< already amount) ERR_ORDER_FILLED)
    (asserts! (<= fill-amount remaining) ERR_FILL_TOO_LARGE)
    ;; at least the minimum slice, or whatever is left
    (asserts! (or (>= fill-amount (min-fill-for amount))
                  (is-eq fill-amount remaining))
              ERR_FILL_TOO_SMALL)
    (asserts! (not (is-eq seller buyer)) ERR_SELF_TRANSFER)
    (asserts! (or (is-eq side SIDE_IDLE) (is-eq side SIDE_BONDED)) ERR_BAD_SIDE)
    (asserts! (is-eq (get status m) STATUS_OPEN) ERR_NOT_OPEN)
    ;; no trading past the deadline: the outcome is already known
    (asserts! (<= burn-block-height (get close-height m)) ERR_WINDOW_CLOSED)
    (asserts! (<= burn-block-height expiry) ERR_ORDER_EXPIRED)
    (asserts! (>= nonce (get-order-floor seller)) ERR_ORDER_CANCELLED)
    ;; the seller must have signed it
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

;; Settle YES. Anyone may call it; the caller brings the proofs.
(define-public (resolve-bonded
                 (id uint)
                 (staker principal)
                 (unlock-burn-height uint)
                 (staker-unlock-bytes (buff 683))
                 (lockup-tx (buff 16384))
                 (lockup-vout uint)
                 (lockup-burn-height uint)
                 (lockup-header (buff 80))
                 (lockup-tx-index uint)
                 (lockup-tx-count uint)
                 (lockup-path (list 14 (buff 32)))
                 (funding-tx (buff 16384))
                 (funding-vout uint)
                 (funding-burn-height uint)
                 (funding-header (buff 80))
                 (funding-tx-index uint)
                 (funding-tx-count uint)
                 (funding-path (list 14 (buff 32))))
  (let ((m       (unwrap! (map-get? markets { id: id }) ERR_NO_MARKET))
        (bidx    (get bond-index (unwrap! (map-get? markets { id: id }) ERR_NO_MARKET)))
        (lockup  (unwrap! (get-bitcoin-tx-output? lockup-tx lockup-vout) ERR_PARSE))
        (funded  (unwrap! (get-bitcoin-tx-output? funding-tx funding-vout) ERR_PARSE))
        (bond    (unwrap! (contract-call? POX5 get-protocol-bond bidx) ERR_NO_BOND))
        (floor   (contract-call? POX5 get-bond-l1-unlock-height bidx)))
    ;; 1. open and inside the window
    (asserts! (is-eq (get status m) STATUS_OPEN) ERR_NOT_OPEN)
    (asserts! (<= burn-block-height (get close-height m)) ERR_WINDOW_CLOSED)
    ;; 2. the lockup must postdate the market
    (asserts! (> lockup-burn-height (get created-at m)) ERR_BOND_TOO_EARLY)
    ;; 3. both txs are on Bitcoin
    (try! (tx-was-mined lockup-burn-height lockup-header (get txid lockup)
                        lockup-tx-index lockup-tx-count lockup-path))
    (try! (tx-was-mined funding-burn-height funding-header (get txid funded)
                        funding-tx-index funding-tx-count funding-path))
    ;; 4. the bonded coins are ones this market committed to at open
    (asserts! (is-some (map-get? snapshots
                { id: id, txid: (get txid funded), vout: funding-vout }))
              ERR_NOT_A_SNAPSHOT)
    (asserts! (is-eq (get script funded) (get subject-script m)) ERR_WRONG_SCRIPT)
    (asserts! (>= (get amount funded) (get threshold-sats m)) ERR_BELOW_THRESHOLD)
    (asserts! (try! (tx-spends-outpoint lockup-tx (get txid funded) funding-vout))
              ERR_NOT_SPENT)
    ;; 5. a real pox-5 lockup for this period; the unlock height is a floor
    (asserts! (>= unlock-burn-height floor) ERR_UNLOCK_TOO_EARLY)
    (asserts! (is-eq (get script lockup)
                     (try! (contract-call? POX5 construct-lockup-output-script
                              staker unlock-burn-height staker-unlock-bytes
                              (get early-unlock-bytes bond))))
              ERR_NOT_A_LOCKUP)
    (asserts! (>= (get amount lockup) (get threshold-sats m)) ERR_BELOW_THRESHOLD)
    ;; 6. pox-5 holds a live L1 bond for this staker at that index
    (let ((mem (unwrap! (contract-call? POX5 get-bond-membership staker)
                        ERR_NO_MEMBERSHIP)))
      (asserts! (is-eq (get bond-index mem) bidx) ERR_NO_MEMBERSHIP)
      (asserts! (get is-l1-lock mem) ERR_NOT_L1)
      (asserts! (>= (get amount-sats mem) (get threshold-sats m)) ERR_BELOW_THRESHOLD)
      (map-set markets { id: id } (merge m { status: STATUS_BONDED }))
      (print { event: "resolve", id: id, outcome: "bonded", staker: staker,
               bond-index: bidx, sats: (get amount-sats mem),
               lockup-burn-height: lockup-burn-height })
      (ok STATUS_BONDED))))

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
      ;; both sides burn; the loser's shares pay nothing
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
