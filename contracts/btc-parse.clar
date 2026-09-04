;; Bitcoin transaction parsing. Pass the NON-WITNESS serialization.

(define-constant ERR_PARSE      (err u300))
(define-constant ERR_OUT_RANGE  (err u301))
(define-constant ERR_TOO_MANY   (err u302))

(define-constant IDX (list u0 u1 u2 u3 u4 u5 u6 u7 u8 u9))

(define-read-only (read-u8 (tx (buff 4096)) (pos uint))
  (match (element-at? tx pos)
    b (some (buff-to-uint-be b))
    none))

(define-read-only (read-u32-le (tx (buff 4096)) (pos uint))
  (match (slice? tx pos (+ pos u4))
    b (match (as-max-len? b u16) bb (some (buff-to-uint-le bb)) none)
    none))

(define-read-only (read-u64-le (tx (buff 4096)) (pos uint))
  (match (slice? tx pos (+ pos u8))
    b (match (as-max-len? b u16) bb (some (buff-to-uint-le bb)) none)
    none))

;; Bitcoin's compact-size integer. Returns the value and how many bytes it ate.
(define-read-only (read-varint (tx (buff 4096)) (pos uint))
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

;; Input layout: txid(32) vout(4) varint scriptlen, script, sequence(4).
(define-private (skip-input
                  (i uint)
                  (acc { tx: (buff 4096), pos: uint, n: uint, ok: bool,
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

;; Does this tx spend the given outpoint? pox-5 does not check this.
(define-read-only (tx-spends-outpoint
                    (tx (buff 4096))
                    (prev-txid (buff 32))
                    (prev-vout uint))
  (match (read-varint tx u4)
    vin-count
      (if (> (get val vin-count) u10)
          ERR_TOO_MANY
          (let ((r (fold skip-input IDX
                     { tx: tx, pos: (+ u4 (get size vin-count)),
                       n: (get val vin-count), ok: true, hits: u0,
                       want-txid: prev-txid, want-vout: prev-vout })))
            (if (get ok r) (ok (> (get hits r) u0)) ERR_PARSE)))
    ERR_PARSE))

;; Skip the inputs to find where the outputs start.
(define-private (advance-input
                  (i uint)
                  (acc { tx: (buff 4096), pos: uint, n: uint, ok: bool }))
  (if (or (not (get ok acc)) (>= i (get n acc)))
      acc
      (let ((tx (get tx acc)) (p (get pos acc)))
        (match (read-varint tx (+ p u36))
          vi (merge acc { pos: (+ p u36 (get size vi) (get val vi) u4) })
          (merge acc { ok: false })))))

(define-private (scan-output
                  (i uint)
                  (acc { tx: (buff 4096), pos: uint, n: uint, ok: bool,
                         want: uint, value: uint, script: (buff 128), found: bool }))
  (if (or (not (get ok acc)) (>= i (get n acc)))
      acc
      (let ((tx (get tx acc)) (p (get pos acc)))
        (match (read-u64-le tx p)
          value
            (match (read-varint tx (+ p u8))
              vi
                (let ((sstart (+ p u8 (get size vi)))
                      (slen   (get val vi)))
                  (if (is-eq i (get want acc))
                      (match (slice? tx sstart (+ sstart slen))
                        s (match (as-max-len? s u128)
                            ss (merge acc { pos: (+ sstart slen), value: value,
                                            script: ss, found: true })
                            (merge acc { ok: false }))
                        (merge acc { ok: false }))
                      (merge acc { pos: (+ sstart slen) })))
              (merge acc { ok: false }))
          (merge acc { ok: false })))))

;; Pull one output: its value in sats and its scriptPubKey.
(define-read-only (get-output (tx (buff 4096)) (index uint))
  (match (read-varint tx u4)
    vin-count
      (if (> (get val vin-count) u10)
          ERR_TOO_MANY
          (let ((after-in (fold advance-input IDX
                            { tx: tx, pos: (+ u4 (get size vin-count)),
                              n: (get val vin-count), ok: true })))
            (if (not (get ok after-in))
                ERR_PARSE
                (match (read-varint tx (get pos after-in))
                  vout-count
                    (if (or (> (get val vout-count) u10) (>= index (get val vout-count)))
                        ERR_OUT_RANGE
                        (let ((r (fold scan-output IDX
                                   { tx: tx,
                                     pos: (+ (get pos after-in) (get size vout-count)),
                                     n: (get val vout-count), ok: true, want: index,
                                     value: u0, script: 0x, found: false })))
                          (if (and (get ok r) (get found r))
                              (ok { value: (get value r), script: (get script r) })
                              ERR_PARSE)))
                  ERR_PARSE))))
    ERR_PARSE))

;; Internal (unreversed) txid, which is what merkle proofs use.
(define-read-only (tx-id (tx (buff 4096)))
  (sha256 (sha256 tx)))

;; Binds a timelocked BTC output to one Stacks principal.
(define-read-only (staker-commitment (staker principal))
  (match (to-consensus-buff? staker)
    b (some (sha256 (sha256 b)))
    none))

;; A P2WSH scriptPubKey is OP_0 (0x00) PUSH32 (0x20) sha256(witnessScript).
(define-read-only (p2wsh-script-pubkey (witness-script (buff 512)))
  (concat 0x0020 (sha256 witness-script)))

;; Does this scriptPubKey commit to this witness script?
(define-read-only (is-p2wsh-for (spk (buff 128)) (witness-script (buff 512)))
  (is-eq spk (p2wsh-script-pubkey witness-script)))

;; Is the staker commitment at `offset` in the witness script?
(define-read-only (script-commits-to-staker
                    (witness-script (buff 512))
                    (staker principal)
                    (offset uint))
  (match (staker-commitment staker)
    c (match (slice? witness-script offset (+ offset u32))
        found (is-eq found c)
        false)
    false))

;; P2WSH match, staker binding, and amount above the bar.
(define-read-only (verify-lockup-output
                    (spk (buff 128))
                    (value uint)
                    (witness-script (buff 512))
                    (staker principal)
                    (min-sats uint))
  (if (not (is-p2wsh-for spk witness-script))
      (err u310)
      (if (< value min-sats)
          (err u311)
          (match (staker-commitment staker)
            c (ok { bound: true, commitment: c, value: value })
            (err u312)))))

;; The whole Bitcoin-side check in one call.
(define-read-only (verify-lockup
                    (spk (buff 128))
                    (value uint)
                    (witness-script (buff 512))
                    (staker principal)
                    (commitment-offset uint)
                    (min-sats uint))
  (begin
    (asserts! (is-p2wsh-for spk witness-script) (err u310))
    (asserts! (>= value min-sats) (err u311))
    (asserts! (script-commits-to-staker witness-script staker commitment-offset) (err u313))
    (ok true)))
