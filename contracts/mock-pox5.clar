;; Simnet stand-in for pox-5. Only the one read-only that At Stake depends on.
;; Real shape, per docs: get-bond-membership returns the decoded
;; protocol-bond-memberships tuple, and returns none once the bond's unlock
;; cycle is reached -- which is exactly the late-resolution trap.

(define-map memberships
  principal
  { bond-index: uint, amount-ustx: uint, signer: principal,
    is-l1-lock: bool, amount-sats: uint })

(define-read-only (get-bond-membership (staker principal))
  (map-get? memberships staker))

;; test helpers
(define-public (set-membership (staker principal) (bond-index uint) (is-l1-lock bool) (amount-sats uint))
  (begin
    (map-set memberships staker
      { bond-index: bond-index, amount-ustx: u1000000, signer: tx-sender,
        is-l1-lock: is-l1-lock, amount-sats: amount-sats })
    (ok true)))

(define-public (clear-membership (staker principal))
  (begin (map-delete memberships staker) (ok true)))
