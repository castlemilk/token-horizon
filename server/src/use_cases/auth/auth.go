// Package auth holds the login business logic: the browser OAuth dance
// (Google/Microsoft) bridged back to the desktop app with claim tickets,
// sessions, and bearer-token authentication. It programs against the store
// port only — no HTTP routing, no SQL here.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/castlemilk/token-horizon/server/src/interfaces/store"
	"github.com/castlemilk/token-horizon/server/src/models/identity"
)

// Supported login providers.
const (
	ProviderGoogle    = "google"
	ProviderMicrosoft = "microsoft"
)

// OAuthConfig carries one provider's confidential-client credentials.
// RedirectURI is always {PublicURL}/v1/auth/{provider}/callback.
type OAuthConfig struct {
	ClientID     string
	ClientSecret string
}

// AuthConfig wires login: provider credentials, public base URL, TTLs.
type AuthConfig struct {
	Google      OAuthConfig
	Microsoft   OAuthConfig
	PublicURL   string
	SessionTTL  time.Duration
	TicketTTL   time.Duration
	HTTPTimeout time.Duration
}

func (c AuthConfig) provider(name string) (OAuthConfig, providerEndpoints, error) {
	switch name {
	case ProviderGoogle:
		return c.Google, providerEndpoints{
			Auth:     "https://accounts.google.com/o/oauth2/v2/auth",
			Token:    "https://oauth2.googleapis.com/token",
			Userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
		}, nil
	case ProviderMicrosoft:
		return c.Microsoft, providerEndpoints{
			Auth:     "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
			Token:    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
			Userinfo: "https://graph.microsoft.com/oidc/userinfo",
		}, nil
	}
	return OAuthConfig{}, providerEndpoints{}, fmt.Errorf("unknown provider %q", name)
}

type providerEndpoints struct{ Auth, Token, Userinfo string }

// Auth implements login: browser dance → ticket → claim → session.
type Auth struct {
	Store  store.Store
	Config AuthConfig
	Client *http.Client
	Now    func() time.Time
}

func (a Auth) now() time.Time {
	if a.Now != nil {
		return a.Now()
	}
	return time.Now().UTC()
}

func (a Auth) client() *http.Client {
	if a.Client != nil {
		return a.Client
	}
	timeout := a.Config.HTTPTimeout
	if timeout == 0 {
		timeout = 15 * time.Second
	}
	return &http.Client{Timeout: timeout}
}

func (a Auth) sessionTTL() time.Duration {
	if a.Config.SessionTTL != 0 {
		return a.Config.SessionTTL
	}
	return 30 * 24 * time.Hour
}

func (a Auth) ticketTTL() time.Duration {
	if a.Config.TicketTTL != 0 {
		return a.Config.TicketTTL
	}
	return 10 * time.Minute
}

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func shaToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// LoginURL mints a claim ticket and returns the provider authorization URL.
// The desktop app opens it in the system browser, then polls Claim(state).
func (a Auth) LoginURL(ctx context.Context, provider string) (loginURL, state string, err error) {
	cfg, eps, err := a.Config.provider(provider)
	if err != nil {
		return "", "", err
	}
	if cfg.ClientID == "" || cfg.ClientSecret == "" {
		return "", "", fmt.Errorf("%s login is not configured", provider)
	}
	state, err = randomHex(16)
	if err != nil {
		return "", "", err
	}
	now := a.now()
	if err := a.Store.CreateTicket(ctx, identity.Ticket{
		State: state, CreatedAt: now, ExpiresAt: now.Add(a.ticketTTL()),
	}); err != nil {
		return "", "", err
	}
	q := url.Values{
		"client_id":     {cfg.ClientID},
		"redirect_uri":  {strings.TrimSuffix(a.Config.PublicURL, "/") + "/v1/auth/" + provider + "/callback"},
		"response_type": {"code"},
		"scope":         {"openid email profile"},
		"state":         {state},
	}
	return eps.Auth + "?" + q.Encode(), state, nil
}

// providerProfile is the normalized userinfo both providers return.
type providerProfile struct {
	Sub     string
	Email   string
	Name    string
	Picture string
}

// Complete finishes the browser dance: validates state, exchanges the code,
// links (or creates) the user, mints a session, and parks it on the ticket
// for Claim. Returns the user for the callback success page.
func (a Auth) Complete(ctx context.Context, provider, code, state string) (identity.User, error) {
	cfg, eps, err := a.Config.provider(provider)
	if err != nil {
		return identity.User{}, err
	}
	if code == "" || state == "" {
		return identity.User{}, errors.New("code + state required")
	}
	prof, err := a.fetchProfile(ctx, cfg, eps, provider, code)
	if err != nil {
		return identity.User{}, err
	}
	if prof.Sub == "" {
		return identity.User{}, errors.New("provider returned no subject")
	}
	now := a.now()
	user, err := a.Store.ResolveUserByProvider(ctx, provider, prof.Sub)
	if err != nil {
		// First sight: mint a unique handle, create, link.
		user, err = a.createLinkedUser(ctx, provider, prof)
		if err != nil {
			return identity.User{}, err
		}
	} else if err := a.Store.LinkProvider(ctx, user.ID, provider, prof.Sub, prof.Email, prof.Picture); err != nil {
		return identity.User{}, err
	}
	token, err := randomHex(32)
	if err != nil {
		return identity.User{}, err
	}
	if err := a.Store.CreateSession(ctx, identity.Session{
		TokenHash: shaToken(token), UserID: user.ID, Provider: provider,
		CreatedAt: now, ExpiresAt: now.Add(a.sessionTTL()),
	}); err != nil {
		return identity.User{}, err
	}
	if err := a.Store.AttachTicketSession(ctx, state, token); err != nil {
		return identity.User{}, errors.New("login ticket expired — restart sign-in")
	}
	return user, nil
}

// createLinkedUser mints a fresh user with a collision-free handle and links
// the provider sub in one step.
func (a Auth) createLinkedUser(ctx context.Context, provider string, prof providerProfile) (identity.User, error) {
	base := identity.NormalizeHandle(strings.Split(prof.Email, "@")[0])
	if base == "" {
		base = identity.NormalizeHandle(prof.Name)
	}
	if base == "" {
		base = "user"
	}
	handle := base
	for n := 1; ; n++ {
		if _, err := a.Store.UserByHandle(ctx, handle); err != nil {
			break // free (or store trouble surfacing at create time)
		}
		handle = fmt.Sprintf("%s-%d", base, n)
	}
	user, err := a.Store.ResolveUser(ctx, handle, prof.Name, "")
	if err != nil {
		return identity.User{}, err
	}
	if err := a.Store.LinkProvider(ctx, user.ID, provider, prof.Sub, prof.Email, prof.Picture); err != nil {
		return identity.User{}, err
	}
	user.Email = prof.Email
	if user.AvatarURL == "" {
		user.AvatarURL = prof.Picture
	}
	if provider == ProviderGoogle {
		user.GoogleSub = prof.Sub
	} else {
		user.MSSub = prof.Sub
	}
	return user, nil
}

// Claim burns a ticket exactly once, returning the session token + user.
// A live ticket with no session yet (browser dance still open) reports
// ErrTicketPending — retryable — so the app polls instead of dying.
func (a Auth) Claim(ctx context.Context, state string) (token string, user identity.User, err error) {
	now := a.now()
	ticket, err := a.Store.Ticket(ctx, state)
	if err != nil {
		return "", identity.User{}, errors.New("ticket invalid, expired, or already claimed")
	}
	if !ticket.RedeemedAt.IsZero() || now.After(ticket.ExpiresAt) {
		return "", identity.User{}, errors.New("ticket invalid, expired, or already claimed")
	}
	if ticket.SessionID == "" {
		return "", identity.User{}, ErrTicketPending
	}
	if _, err := a.Store.ClaimTicket(ctx, state); err != nil {
		return "", identity.User{}, errors.New("ticket invalid, expired, or already claimed")
	}
	sess, err := a.Store.SessionByToken(ctx, shaToken(ticket.SessionID))
	if err != nil {
		return "", identity.User{}, errors.New("session missing")
	}
	if sess.Expired(now) {
		return "", identity.User{}, errors.New("session expired")
	}
	user, err = a.Store.UserByID(ctx, sess.UserID)
	if err != nil {
		return "", identity.User{}, errors.New("account missing")
	}
	return ticket.SessionID, user, nil
}

// ErrTicketPending signals "not yet" (browser dance still open).
var ErrTicketPending = errors.New("ticket pending — complete sign-in in the browser")

// Authenticate resolves a bearer token to its user (sessions only; the
// service sync token is checked by the HTTP layer, not here).
func (a Auth) Authenticate(ctx context.Context, token string) (identity.User, error) {
	if token == "" {
		return identity.User{}, errors.New("no token")
	}
	sess, err := a.Store.SessionByToken(ctx, shaToken(token))
	if err != nil {
		return identity.User{}, errors.New("unknown session")
	}
	if sess.Expired(a.now()) {
		return identity.User{}, errors.New("session expired")
	}
	return a.Store.UserByID(ctx, sess.UserID)
}

// Logout revokes one session token.
func (a Auth) Logout(ctx context.Context, token string) error {
	if token == "" {
		return errors.New("no token")
	}
	return a.Store.DeleteSession(ctx, shaToken(token))
}

func (a Auth) fetchProfile(ctx context.Context, cfg OAuthConfig, eps providerEndpoints, provider, code string) (providerProfile, error) {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"client_id":     {cfg.ClientID},
		"client_secret": {cfg.ClientSecret},
		"redirect_uri":  {strings.TrimSuffix(a.Config.PublicURL, "/") + "/v1/auth/" + provider + "/callback"},
	}
	req, err := http.NewRequestWithContext(ctx, "POST", eps.Token, strings.NewReader(form.Encode()))
	if err != nil {
		return providerProfile{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := a.client().Do(req)
	if err != nil {
		return providerProfile{}, fmt.Errorf("token exchange: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode != 200 {
		return providerProfile{}, fmt.Errorf("token exchange: HTTP %d", resp.StatusCode)
	}
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(body, &tok); err != nil || tok.AccessToken == "" {
		return providerProfile{}, errors.New("token exchange: no access token")
	}
	uireq, err := http.NewRequestWithContext(ctx, "GET", eps.Userinfo, nil)
	if err != nil {
		return providerProfile{}, err
	}
	uireq.Header.Set("Authorization", "Bearer "+tok.AccessToken)
	uiresp, err := a.client().Do(uireq)
	if err != nil {
		return providerProfile{}, fmt.Errorf("userinfo: %w", err)
	}
	defer uiresp.Body.Close()
	uibody, _ := io.ReadAll(io.LimitReader(uiresp.Body, 1<<16))
	if uiresp.StatusCode != 200 {
		return providerProfile{}, fmt.Errorf("userinfo: HTTP %d", uiresp.StatusCode)
	}
	var ui struct {
		Sub     string `json:"sub"`
		ID      string `json:"id"`
		Email   string `json:"email"`
		Name    string `json:"name"`
		Picture string `json:"picture"`
	}
	if err := json.Unmarshal(uibody, &ui); err != nil {
		return providerProfile{}, err
	}
	sub := ui.Sub
	if sub == "" {
		sub = ui.ID // Microsoft graph shape
	}
	return providerProfile{Sub: sub, Email: ui.Email, Name: ui.Name, Picture: ui.Picture}, nil
}
