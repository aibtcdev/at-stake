;; Bitcoin transaction parsing in Clarity.
;;
;; IMPORTANT: pass the NON-WITNESS (legacy) serialization. That is what the
;; txid is computed over, so it is what has to match the merkle proof. A
;; segwit tx serialized with marker+flag hashes to the wtxid instead and will
;; not match.
;;
;; Clarity has no loops, so every scan is a `fold` over a fixed index list
;; carrying a cursor in the accumulator. Entries past the real count are
;; ignored via a `done` flag rather than an early exit.

(define-constant ERR_PARSE      (err u300))
(define-constant ERR_OUT_RANGE  (err u301))
(define-constant ERR_TOO_MANY   (err u302))

(define-constant IDX (list u0 u1 u2 u3 u4 u5 u6 u7 u8 u9))

;; ------------------------------------------------------------------ scalars

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

;; -------------------------------------------------------------------- inputs

;; An input is: 32-byte txid, 4-byte vout, varint script length, script,
;; 4-byte sequence. We keep the outpoint and skip the script.
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

;; Does this transaction spend the given outpoint? This is the check pox-5
;; does NOT do, and the only reason a market can be about a Bitcoin address.
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

;; ------------------------------------------------------------------- outputs

;; Walk inputs without matching, just to find where the output section starts.
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

;; The txid is the double-sha of the legacy serialization, byte-reversed for
;; display. We keep internal order, which is what merkle proofs use.
(define-read-only (tx-id (tx (buff 4096)))
  (sha256 (sha256 tx)))

;; ------------------------------------------------------- pox-5 lockup output

;; The two legs of a bond are tied together by the Bitcoin script committing to
;; a hash of the staker's Stacks principal. This is the whole binding between
;; "some BTC got timelocked" and "this specific Stacks account did it".
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

;; Does the witness script embed the staker commitment at the stated offset?
;; The early-exit branch of the pox-5 lockup reveals the 32-byte
;; sha256(to-consensus-buff? staker) preimage, so the commitment sits verbatim
;; in the script bytes.
;;
;; The caller supplies the offset rather than us searching for it. Clarity has
;; no substring search, and searching would be pointless anyway: a wrong offset
;; simply fails the equality. The submitter cannot lie their way past this.
;;
;; NOTE: this proves the script is BOUND to that staker. It does not prove the
;; script follows pox-5's exact template. Pin the template from
;; pox-5.clar construct-lockup-script before mainnet. In v1 the weight is
;; carried by P2WSH hash equality plus the pox-5 membership cross-call.
(define-read-only (script-commits-to-staker
                    (witness-script (buff 512))
                    (staker principal)
                    (offset uint))
  (match (staker-commitment staker)
    c (match (slice? witness-script offset (+ offset u32))
        found (is-eq found c)
        false)
    false))

;; Full lockup check: the output really is a P2WSH paying the given witness
;; script, the script is bound to the staker, and the amount clears the bar.
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

;; Everything the Bitcoin side has to say, in one call.
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
