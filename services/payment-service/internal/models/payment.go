package models

import "time"

type Status string

const (
	StatusPending   Status = "PENDING"
	StatusCompleted Status = "COMPLETED"
	StatusFailed    Status = "FAILED"
)

type Payment struct {
	ID          string
	OrderID     string
	CustomerID  *string
	AmountCents int64
	Status      Status
	Method      string
	CreatedAt   time.Time
}
