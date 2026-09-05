;; SIMNET ONLY. Never deployed. Proves that at-stake cannot be driven through
;; an intermediate contract: it authorises on contract-caller, not tx-sender.
(define-public (steal (id uint) (side uint) (amount uint) (thief principal))
  (contract-call? .at-stake-sim transfer-shares id side amount thief))

(define-public (grief-cancel (n uint))
  (contract-call? .at-stake-sim cancel-orders-below n))
