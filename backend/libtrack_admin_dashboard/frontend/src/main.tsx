import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  IonApp,
  IonContent,
  IonHeader,
  IonTitle,
  IonToolbar,
  IonSearchbar,
  IonCard,
  IonCardHeader,
  IonCardTitle,
  IonCardSubtitle,
  IonCardContent,
  IonBadge,
  IonButton,
  IonText,
  IonInput,
  IonSpinner,
  setupIonicReact,
} from '@ionic/react';

import '@ionic/react/css/core.css';
import '@ionic/react/css/normalize.css';
import '@ionic/react/css/structure.css';
import '@ionic/react/css/typography.css';
import './theme.css';

setupIonicReact();

type Book = {
  id: number;
  title: string;
  author: string;
  category: string;
  available_copies: number;
  total_copies: number;
  available: boolean;
};

type AuthUser = {
  id?: number;
  full_name?: string;
  name?: string;
  email?: string;
  role?: string;
};

const API = (
  import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000'
).replace(/\/+$/, '');

const TOKEN_KEY = 'libtrack_access_token';

async function readResponse(response: Response) {
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = data?.detail;
    const message =
      typeof detail === 'string'
        ? detail
        : Array.isArray(detail)
          ? detail.map((item: { msg?: string }) => item.msg || '').filter(Boolean).join(', ')
          : `Request failed (${response.status})`;

    throw new Error(message || `Request failed (${response.status})`);
  }

  return data;
}

function getNetworkError(err: unknown) {
  if (err instanceof TypeError) {
    return `Hindi maabot ang API (${API}). Tiyaking tumatakbo ang backend, tama ang VITE_API_URL, at pinapayagan ng firewall ang port 8000. Kung cellphone ang gamit, gamitin ang laptop IP sa .env.`;
  }

  return err instanceof Error ? err.message : 'May hindi inaasahang error. Subukan ulit.';
}

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) || '');
  const [isRegister, setIsRegister] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [query, setQuery] = useState('');
  const [books, setBooks] = useState<Book[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [booksLoading, setBooksLoading] = useState(false);

  async function handleAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setNotice('');
    setLoading(true);

    try {
      if (isRegister) {
        const response = await fetch(`${API}/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // Backend RegisterRequest expects full_name, not name.
            full_name: name.trim(),
            email: email.trim(),
            password,
          }),
        });

        await readResponse(response);
        setIsRegister(false);
        setPassword('');
        setNotice('Account created successfully. Please log in.');
      } else {
        const response = await fetch(`${API}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: email.trim(),
            password,
          }),
        });

        const data = await readResponse(response);
        const accessToken = data?.access_token;

        if (typeof accessToken !== 'string' || !accessToken) {
          throw new Error('Walang access token sa login response ng backend.');
        }

        sessionStorage.setItem(TOKEN_KEY, accessToken);
        setToken(accessToken);
        setUser({
          id: data.id,
          full_name: data.full_name,
          name: data.full_name,
          email: data.email || email.trim(),
          role: data.role,
        });
        setPassword('');
        setNotice('');
      }
    } catch (err) {
      setError(getNetworkError(err));
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken('');
    setUser(null);
    setBooks([]);
    setQuery('');
    setEmail('');
    setPassword('');
    setName('');
    setError('');
    setNotice('');
  }

  useEffect(() => {
    if (!token) return;

    let cancelled = false;

    async function loadBooks() {
      setBooksLoading(true);
      setError('');

      try {
        // /books is public in this backend; no token is required.
        const response = await fetch(
          `${API}/books?q=${encodeURIComponent(query)}`,
        );
        const data = await readResponse(response);

        if (!cancelled) {
          setBooks(Array.isArray(data) ? data : []);
        }
      } catch (err) {
        if (!cancelled) setError(`Hindi ma-load ang catalog: ${getNetworkError(err)}`);
      } finally {
        if (!cancelled) setBooksLoading(false);
      }
    }

    const timer = window.setTimeout(loadBooks, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [token, query]);

  const totalBooks = books.reduce((sum, book) => sum + (Number(book.total_copies) || 0), 0);
  const availableCopies = books.reduce((sum, book) => sum + (Number(book.available_copies) || 0), 0);
  const unavailableTitles = books.filter((book) => !book.available).length;
  const isAdmin = (user?.role || '').toLowerCase() === 'admin';

  return (
    <IonApp>
      <IonHeader className="top-header">
        <IonToolbar>
          <div className="topbar-inner">
            <div className="brand-lockup">
              <div className="brand-mark" aria-hidden="true">📚</div>
              <div><strong>LibTrack</strong><small>LIBRARY MANAGEMENT</small></div>
            </div>
            {token && <div className="header-user"><span className="user-dot" /> <span>{user?.full_name || user?.name || user?.email || 'Library Member'}</span></div>}
          </div>
        </IonToolbar>
      </IonHeader>

      <IonContent className="dashboard-content">
        {!token ? (
          <main className="auth-layout">
            <section className="auth-showcase">
              <span className="gold-kicker">YOUR LIBRARY, ORGANIZED</span>
              <h1>Every great journey starts with a <em>book.</em></h1>
              <p>Discover your next read, keep track of your library, and make every page count with LibTrack.</p>
              <div className="showcase-stat"><span>✦</span><div><strong>Read more. Discover more.</strong><small>Your library, all in one place.</small></div></div>
              <div className="decor-book decor-book-one" /><div className="decor-book decor-book-two" /><div className="decor-book decor-book-three" />
            </section>
            <section className="auth-panel">
              <div className="auth-heading"><span className="auth-icon">♧</span><p className="eyebrow">LIBTRACK ACCOUNT</p><h2>{isRegister ? 'Create your account' : 'Welcome back'}</h2><p>{isRegister ? 'Join your library community to get started.' : 'Sign in to access your library dashboard.'}</p></div>
              <form onSubmit={handleAuth} className="auth-form">
                {isRegister && <IonInput label="Full name" labelPlacement="stacked" fill="outline" value={name} placeholder="Enter your full name" onIonInput={(e) => setName(String(e.detail.value ?? ''))} required minlength={2} maxlength={150} />}
                <IonInput label="Email address" labelPlacement="stacked" fill="outline" type="email" value={email} placeholder="you@example.com" autocomplete="email" onIonInput={(e) => setEmail(String(e.detail.value ?? ''))} required />
                <IonInput label="Password" labelPlacement="stacked" fill="outline" type="password" value={password} placeholder={isRegister ? 'At least 10 characters' : 'Enter your password'} autocomplete={isRegister ? 'new-password' : 'current-password'} onIonInput={(e) => setPassword(String(e.detail.value ?? ''))} required minlength={isRegister ? 10 : 1} maxlength={128} />
                {error && <IonText color="danger"><p role="alert" className="form-message">{error}</p></IonText>}
                {notice && <IonText color="success"><p role="status" className="form-message">{notice}</p></IonText>}
                <IonButton type="submit" expand="block" disabled={loading} className="gold-button">{loading ? <IonSpinner name="crescent" /> : isRegister ? 'Create Account' : 'Sign In'} <span className="button-arrow">→</span></IonButton>
              </form>
              <p className="switch-auth">{isRegister ? 'Already have an account?' : "Don't have an account yet?"}</p>
              <IonButton expand="block" fill="clear" className="switch-button" onClick={() => { setIsRegister(!isRegister); setError(''); setNotice(''); }}>{isRegister ? 'Back to Login' : 'Create an account'}</IonButton>
              <p className="auth-foot">By continuing, you agree to use LibTrack responsibly.</p>
            </section>
          </main>
        ) : (
          <main className="dashboard-shell">
            {isAdmin ? (
              <section className="welcome-banner admin-banner">
                <div className="welcome-copy"><span className="gold-kicker">LIBTRACK • ADMINISTRATION</span><h1>Admin dashboard, <em>{(user?.full_name || user?.name || 'Admin').split(' ')[0]}.</em></h1><p>Manage your library overview and monitor the book catalog from one place.</p><IonButton className="gold-button banner-button" onClick={() => document.getElementById('catalog')?.scrollIntoView({ behavior: 'smooth' })}>Manage Book Catalog <span className="button-arrow">→</span></IonButton></div>
                <div className="banner-art" aria-hidden="true"><div className="art-circle"/><div className="art-book art-book-a"/><div className="art-book art-book-b"/><div className="art-book art-book-c"/><div className="art-plant">✦</div></div>
              </section>
            ) : (
              <section className="welcome-banner">
                <div className="welcome-copy"><span className="gold-kicker">LIBRARY OVERVIEW</span><h1>Good to see you, <em>{(user?.full_name || user?.name || 'Reader').split(' ')[0]}.</em></h1><p>Your library at a glance. What would you like to read today?</p><IonButton className="gold-button banner-button" onClick={() => document.getElementById('catalog')?.scrollIntoView({ behavior: 'smooth' })}>Explore Book Catalog <span className="button-arrow">→</span></IonButton></div>
                <div className="banner-art" aria-hidden="true"><div className="art-circle"/><div className="art-book art-book-a"/><div className="art-book art-book-b"/><div className="art-book art-book-c"/><div className="art-plant">✦</div></div>
              </section>
            )}

            <section className="stats-grid" aria-label="Library statistics">
              <article className="stat-card"><div className="stat-icon blue-icon">▤</div><div><span>Total copies</span><strong>{booksLoading ? '—' : totalBooks}</strong><small>Based on catalog results</small></div><span className="stat-corner">↗</span></article>
              <article className="stat-card"><div className="stat-icon gold-icon">✓</div><div><span>Available copies</span><strong>{booksLoading ? '—' : availableCopies}</strong><small>Ready to borrow</small></div><span className="stat-corner">↗</span></article>
              <article className="stat-card"><div className="stat-icon mint-icon">▣</div><div><span>Book titles</span><strong>{booksLoading ? '—' : books.length}</strong><small>Matching catalog results</small></div><span className="stat-corner">↗</span></article>
              <article className="stat-card"><div className="stat-icon rose-icon">◷</div><div><span>Unavailable titles</span><strong>{booksLoading ? '—' : unavailableTitles}</strong><small>Currently not available</small></div><span className="stat-corner">↗</span></article>
            </section>
            {isAdmin && <section className="admin-note"><strong>Admin view</strong><span>Statistics reflect the books returned by the current catalog search. Member and borrowing management require matching backend API endpoints.</span></section>}

            <section className="catalog-section" id="catalog">
              <div className="section-heading"><div><span className="eyebrow">{isAdmin ? 'CATALOG MANAGEMENT' : 'FIND YOUR NEXT READ'}</span><h2>{isAdmin ? 'Book Inventory' : 'Book Catalog'}</h2><p>{isAdmin ? 'Review titles, copy counts, categories, and availability.' : 'Search by title or author and check availability.'}</p></div><div className="catalog-count">{books.length} result{books.length === 1 ? '' : 's'}</div></div>
              <IonSearchbar className="catalog-search" value={query} onIonInput={(e) => setQuery(e.detail.value || '')} placeholder="Search books or authors..." />
              {error && <IonText color="danger"><p role="alert" className="form-message">{error}</p></IonText>}
              {booksLoading && <div className="loading-row"><IonSpinner name="crescent" /><span>Loading catalog...</span></div>}
              {!booksLoading && books.length > 0 && (isAdmin ? (
                <div className="admin-table-wrap"><table className="admin-book-table"><thead><tr><th>Book title</th><th>Author</th><th>Category</th><th>Copies</th><th>Status</th></tr></thead><tbody>{books.map((book) => <tr key={book.id}><td><strong>{book.title}</strong><small>Book ID: {book.id}</small></td><td>{book.author}</td><td><span className="table-category">{book.category || 'General'}</span></td><td>{book.available_copies}/{book.total_copies}</td><td><IonBadge color={book.available ? 'success' : 'medium'}>{book.available ? 'Available' : 'Unavailable'}</IonBadge></td></tr>)}</tbody></table></div>
              ) : (
                <div className="book-grid">{books.map((book, index) => <article key={book.id} className="book-tile"><div className={`book-cover cover-${index % 5}`}><span className="cover-brand">LIBTRACK PICKS</span><span className="cover-title">{book.title}</span><span className="cover-rule"/><span className="cover-author">{book.author}</span><span className="cover-decoration">✦</span></div><div className="book-info"><span className="book-category">{book.category || 'General'}</span><h3>{book.title}</h3><p>by {book.author}</p><div className="book-meta"><IonBadge color={book.available ? 'success' : 'medium'}>{book.available ? `${book.available_copies} available` : 'Unavailable'}</IonBadge><span>{book.available_copies}/{book.total_copies} copies</span></div></div></article>)}</div>
              ))}
              {!booksLoading && !books.length && !error && <div className="empty-state"><span>⌕</span><h3>No books found</h3><p>Try a different search, or check back when the catalog has books.</p></div>}
            </section>
            <footer className="dashboard-footer"><span>📚 <strong>LibTrack</strong> · Library Management System</span><button type="button" onClick={logout}>Log Out ↗</button></footer>
          </main>
        )}
      </IonContent>
    </IonApp>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
