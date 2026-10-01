'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Package, Loader2, Eye, EyeOff } from 'lucide-react';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Login failed');
        setLoading(false);
        return;
      }

      localStorage.setItem('auth_token', data.token);
      localStorage.setItem('auth_user', JSON.stringify(data.user));
      // A login that may not see orders (a chat-only team member) starts in Chat Support.
      const perms: string[] = Array.isArray(data.user?.permissions) ? data.user.permissions : [];
      router.push(data.user?.role === 'admin' || perms.includes('orders.view') ? '/admin' : '/admin/chat');
    } catch {
      setError('Network error. Please try again.');
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      {/* Floating shapes */}
      <div className="login-float login-float-1" />
      <div className="login-float login-float-2" />
      <div className="login-float login-float-3" />

      <div className="login-card">
        <div className="tf-card" style={{ padding: '2rem' }}>
          {/* Brand */}
          <div className="login-brand">
            <div className="login-brand-icon">
              <Package />
            </div>
            <h1>TrackFlow</h1>
            <p>Sign in to your account</p>
          </div>

          {/* Error */}
          {error && (
            <div className="alert-band alert-error-band" style={{ marginBottom: '1rem' }}>
              <span>{error}</span>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="form-group">
              <label className="form-label">Username</label>
              <input
                type="text"
                className="form-input"
                placeholder="Enter your username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoFocus
              />
            </div>

            <div className="form-group">
              <label className="form-label">Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showPassword ? 'text' : 'password'}
                  className="form-input"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  style={{ paddingRight: '2.5rem' }}
                />
                <button
                  type="button"
                  className="input-password-toggle"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading}
              style={{ width: '100%', height: '2.75rem', marginTop: '0.5rem' }}
            >
              {loading ? (
                <>
                  <Loader2 size={16} className="spinner-sm" style={{ border: 'none', animation: 'spin 0.6s linear infinite' }} />
                  Signing in...
                </>
              ) : (
                'Sign in'
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
