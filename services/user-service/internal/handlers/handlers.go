package handlers

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/food-delivery/user-service/internal/auth"
	"github.com/food-delivery/user-service/internal/db"
	"github.com/food-delivery/user-service/internal/middleware"
	"github.com/food-delivery/user-service/internal/models"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgconn"
)

type handler struct {
	store  *db.Store
	signer *auth.Signer
}

func New(store *db.Store, signer *auth.Signer) *handler {
	return &handler{store: store, signer: signer}
}

func errResp(c *gin.Context, status int, code, msg string) {
	c.AbortWithStatusJSON(status, gin.H{"error": code, "message": msg})
}

func serverErr(c *gin.Context, op string, err error) {
	slog.Error("handler error", "op", op, "path", c.FullPath(), "err", err)
	c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{
		"error":   "internal_error",
		"message": "internal server error",
	})
}

func toUser(r *db.UserRow) models.User { return r.User }

type registerReq struct {
	Email    string `json:"email" binding:"required,email"`
	Password string `json:"password" binding:"required,min=8"`
	Role     string `json:"role" binding:"required"`
	FullName string `json:"full_name" binding:"required"`
	Phone    string `json:"phone" binding:"required"`
}

func (h *handler) Register(c *gin.Context) {
	var req registerReq
	if err := c.ShouldBindJSON(&req); err != nil {
		errResp(c, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	role := models.Role(req.Role)
	if !role.Valid() {
		errResp(c, http.StatusBadRequest, "invalid_role", "role must be customer|restaurant|delivery")
		return
	}
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		serverErr(c, "hash", err)
		return
	}
	u, err := h.store.CreateUser(c, strings.ToLower(req.Email), hash, role, req.FullName, req.Phone)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			errResp(c, http.StatusConflict, "email_taken", "email already registered")
			return
		}
		serverErr(c, "db", err)
		return
	}
	token, err := h.signer.Issue(u.ID, string(u.Role))
	if err != nil {
		serverErr(c, "token", err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"user": toUser(u), "token": token})
}

type loginReq struct {
	Email    string `json:"email" binding:"required,email"`
	Password string `json:"password" binding:"required"`
}

func (h *handler) Login(c *gin.Context) {
	var req loginReq
	if err := c.ShouldBindJSON(&req); err != nil {
		errResp(c, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	u, err := h.store.GetUserByEmail(c, strings.ToLower(req.Email))
	if err != nil {
		if errors.Is(err, db.ErrNotFound) {
			errResp(c, http.StatusUnauthorized, "invalid_credentials", "email or password incorrect")
			return
		}
		serverErr(c, "db", err)
		return
	}
	if !auth.CheckPassword(u.PasswordHash, req.Password) {
		errResp(c, http.StatusUnauthorized, "invalid_credentials", "email or password incorrect")
		return
	}
	token, err := h.signer.Issue(u.ID, string(u.Role))
	if err != nil {
		serverErr(c, "token", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"user": toUser(u), "token": token})
}

func (h *handler) Me(c *gin.Context) {
	id := c.GetString(middleware.CtxUserID)
	u, err := h.store.GetUserByID(c, id)
	if err != nil {
		if errors.Is(err, db.ErrNotFound) {
			errResp(c, http.StatusNotFound, "not_found", "user not found")
			return
		}
		serverErr(c, "db", err)
		return
	}
	c.JSON(http.StatusOK, toUser(u))
}

type patchMeReq struct {
	FullName *string `json:"full_name"`
	Phone    *string `json:"phone"`
	Password *string `json:"password"`
}

func (h *handler) PatchMe(c *gin.Context) {
	var req patchMeReq
	if err := c.ShouldBindJSON(&req); err != nil {
		errResp(c, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	fields := db.UpdateUserFields{FullName: req.FullName, Phone: req.Phone}
	if req.Password != nil {
		if len(*req.Password) < 8 {
			errResp(c, http.StatusBadRequest, "invalid_request", "password must be >=8 chars")
			return
		}
		hash, err := auth.HashPassword(*req.Password)
		if err != nil {
			serverErr(c, "hash", err)
			return
		}
		fields.PasswordHash = &hash
	}
	id := c.GetString(middleware.CtxUserID)
	u, err := h.store.UpdateUser(c, id, fields)
	if err != nil {
		if errors.Is(err, db.ErrNotFound) {
			errResp(c, http.StatusNotFound, "not_found", "user not found")
			return
		}
		serverErr(c, "db", err)
		return
	}
	c.JSON(http.StatusOK, toUser(u))
}

func (h *handler) GetUser(c *gin.Context) {
	id := c.Param("id")
	u, err := h.store.GetUserByID(c, id)
	if err != nil {
		if errors.Is(err, db.ErrNotFound) {
			errResp(c, http.StatusNotFound, "not_found", "user not found")
			return
		}
		serverErr(c, "db", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"id":        u.ID,
		"full_name": u.FullName,
		"role":      u.Role,
	})
}
