package money

import (
	"fmt"
	"math"
	"strconv"
)

// FromFloat converts a decimal-as-float64 (as it arrives in JSON events)
// to integer cents. Rounds half-away-from-zero.
func FromFloat(v float64) int64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return int64(math.Round(v * 100))
}

// FromString parses a decimal string ("28.00") into integer cents.
func FromString(s string) (int64, error) {
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, err
	}
	return FromFloat(f), nil
}

// ToString formats cents as a fixed-2-decimal string ("28.00").
func ToString(cents int64) string {
	sign := ""
	if cents < 0 {
		sign = "-"
		cents = -cents
	}
	return fmt.Sprintf("%s%d.%02d", sign, cents/100, cents%100)
}

// ToFloat formats cents as a float ("28.00" → 28.0). Used in event payloads.
func ToFloat(cents int64) float64 {
	return float64(cents) / 100.0
}
