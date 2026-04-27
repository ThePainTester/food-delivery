package services

import (
	"context"
	"strings"
	"time"
)

// chargeViaGateway simulates calling an external payment provider (Stripe,
// Adyen, etc.). It sleeps to imitate network latency and returns a fixed
// outcome based on the card number — useful so the demo can show both the
// happy path and the failure path without random flakiness.
//
// REPLACE THIS in a real deployment with an actual SDK call, e.g.:
//
//   pi, err := stripe.PaymentIntents.New(&stripe.PaymentIntentParams{
//       Amount: stripe.Int64(amountCents), Currency: stripe.String("usd"),
//       PaymentMethod: stripe.String(paymentMethodID), Confirm: stripe.Bool(true),
//   })
//
// The signature/return contract here is what the rest of the service relies
// on, so swapping providers is a one-file change.
func chargeViaGateway(ctx context.Context, cardNumber string, amountCents int64) (gatewayResult, error) {
	const simulatedLatency = 1500 * time.Millisecond
	select {
	case <-ctx.Done():
		return gatewayResult{}, ctx.Err()
	case <-time.After(simulatedLatency):
	}

	// Demo trick: any card number ending in "0000" is declined. Everything
	// else is approved. A real provider would return a structured response
	// with decline codes; we collapse it to ok/reason here.
	clean := strings.ReplaceAll(strings.ReplaceAll(cardNumber, " ", ""), "-", "")
	if strings.HasSuffix(clean, "0000") {
		return gatewayResult{ok: false, reason: "card_declined"}, nil
	}
	last4 := ""
	if len(clean) >= 4 {
		last4 = clean[len(clean)-4:]
	}
	return gatewayResult{ok: true, last4: last4, providerRef: "demo_" + last4}, nil
}

type gatewayResult struct {
	ok          bool
	reason      string
	last4       string
	providerRef string
}
