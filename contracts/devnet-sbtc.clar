;; DEVNET ONLY. Never deployed to testnet or mainnet.
;;
;; The real sBTC token cannot be minted on a devnet we run ourselves: its
;; protocol-mint is gated on sbtc-registry's active-protocol-contracts map,
;; which is empty at deploy and can only be written by an already-registered
;; governance caller. Chicken and egg.
;;
;; So devnet substitutes this for the COLLATERAL only. Everything that makes
;; At Stake interesting -- the Bitcoin SPV proofs, the burn-header binding,
;; the real pox-5 membership read -- is untouched and still real.
;;
;; SIP-010 shaped, with an open faucet so any wallet can fund itself.

(define-fungible-token sbtc-token)

(define-constant ERR_NOT_OWNER (err u4))
(define-constant FAUCET_AMOUNT u1000000000) ;; 10 sBTC

(define-public (transfer (amount uint) (sender principal) (recipient principal)
                         (memo (optional (buff 34))))
  (begin
    (asserts! (is-eq tx-sender sender) ERR_NOT_OWNER)
    (try! (ft-transfer? sbtc-token amount sender recipient))
    (match memo m (print m) 0x)
    (ok true)))

;; Anyone may fund themselves. This is a throwaway chain.
(define-public (faucet)
  (ft-mint? sbtc-token FAUCET_AMOUNT tx-sender))

(define-public (faucet-to (who principal))
  (ft-mint? sbtc-token FAUCET_AMOUNT who))

(define-read-only (get-balance (who principal)) (ok (ft-get-balance sbtc-token who)))
(define-read-only (get-total-supply) (ok (ft-get-supply sbtc-token)))
(define-read-only (get-name) (ok "sBTC"))
(define-read-only (get-symbol) (ok "sBTC"))
(define-read-only (get-decimals) (ok u8))
(define-read-only (get-token-uri) (ok none))
