package db

import (
	"context"
	"errors"
	"time"

	"github.com/exaring/otelpgx"
	"github.com/food-delivery/user-service/internal/models"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("not found")

type Store struct {
	Pool *pgxpool.Pool
}

func New(ctx context.Context, url string) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = 10
	cfg.MaxConnLifetime = time.Hour
	cfg.ConnConfig.Tracer = otelpgx.NewTracer()

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return &Store{Pool: pool}, nil
}

func (s *Store) Close() { s.Pool.Close() }

type UserRow struct {
	models.User
	PasswordHash string
}

func (s *Store) CreateUser(ctx context.Context, email, passwordHash string, role models.Role, fullName, phone string) (*UserRow, error) {
	var u UserRow
	err := s.Pool.QueryRow(ctx, `
		INSERT INTO users (email, password_hash, role, full_name, phone)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, email, password_hash, role, full_name, phone, created_at
	`, email, passwordHash, role, fullName, phone).Scan(
		&u.ID, &u.Email, &u.PasswordHash, &u.Role, &u.FullName, &u.Phone, &u.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *Store) GetUserByEmail(ctx context.Context, email string) (*UserRow, error) {
	var u UserRow
	err := s.Pool.QueryRow(ctx, `
		SELECT id, email, password_hash, role, full_name, phone, created_at
		FROM users WHERE email = $1
	`, email).Scan(&u.ID, &u.Email, &u.PasswordHash, &u.Role, &u.FullName, &u.Phone, &u.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *Store) GetUserByID(ctx context.Context, id string) (*UserRow, error) {
	var u UserRow
	err := s.Pool.QueryRow(ctx, `
		SELECT id, email, password_hash, role, full_name, phone, created_at
		FROM users WHERE id = $1
	`, id).Scan(&u.ID, &u.Email, &u.PasswordHash, &u.Role, &u.FullName, &u.Phone, &u.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

type UpdateUserFields struct {
	FullName     *string
	Phone        *string
	PasswordHash *string
}

func (s *Store) UpdateUser(ctx context.Context, id string, f UpdateUserFields) (*UserRow, error) {
	var u UserRow
	err := s.Pool.QueryRow(ctx, `
		UPDATE users SET
			full_name     = COALESCE($2, full_name),
			phone         = COALESCE($3, phone),
			password_hash = COALESCE($4, password_hash)
		WHERE id = $1
		RETURNING id, email, password_hash, role, full_name, phone, created_at
	`, id, f.FullName, f.Phone, f.PasswordHash).Scan(
		&u.ID, &u.Email, &u.PasswordHash, &u.Role, &u.FullName, &u.Phone, &u.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}
