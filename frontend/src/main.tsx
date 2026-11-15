import React, { useEffect, useMemo, useRef, useState } from 'react';

import { createRoot } from 'react-dom/client';

import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

import {

  IonApp,

  IonContent,

  IonBadge,

  IonButton,

  IonIcon,

  IonText,

  IonInput,

  IonSelect,

  IonSelectOption,

  IonSpinner,

  IonSearchbar,

  setupIonicReact,

} from '@ionic/react';

import { alertController } from '@ionic/core/components';
import { logOutOutline, notificationsOutline } from 'ionicons/icons';

import '@ionic/react/css/core.css';

import '@ionic/react/css/normalize.css';

import '@ionic/react/css/structure.css';

import '@ionic/react/css/typography.css';

import './theme.css';

setupIonicReact();

const API = (import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');

// Library borrowing days are Monday-Friday, based on Philippine local time.
function isPhilippineWeekend(): boolean {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    weekday: 'short',
  }).format(new Date());
  return weekday === 'Sat' || weekday === 'Sun';
}


const TOKEN_KEY = 'libtrack_access_token';

// Display backend timestamps in Philippine time (Asia/Manila, UTC+8).
// The backend currently stores naive UTC timestamps, so add Z when no
// timezone suffix is present. Timestamps that already include a timezone
// are parsed as supplied.
function formatPhilippineTime(timestamp: string) {
  const value = /(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp)
    ? timestamp
    : `${timestamp}Z`;

  return new Date(value).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

type Book = {

  id: number;

  title: string;

  author: string;

  category: string;

  isbn?: string | null;

  call_number?: string | null;

  description?: string | null;

  cover_image?: string | null;

  available_copies: number;

  total_copies: number;

  available: boolean;

};


function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read the selected photo.'));
    reader.readAsDataURL(file);
  });
}

function resolveBookImageUrl(value?: string | null): string | null {
  if (!value?.trim()) return null;

  const path = value.trim();

  // Supabase URLs are already complete. Do not prepend the API URL.
  if (/^https?:\/\//i.test(path)) return path;

  // Local backend upload paths still use the API URL.
  return `${API}${path.startsWith('/') ? '' : '/'}${path}`;
}

function BookCover({
  book,
  index = 0,
  className = "book-cover"
}: {
  book: Book;
  index?: number;
  className?: string;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(
    () => resolveBookImageUrl(book.cover_image)
  );

  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    setImageFailed(false);

    const coverUrl = resolveBookImageUrl(book.cover_image);

    if (coverUrl) {
      setImageUrl(coverUrl);
      return () => {
        cancelled = true;
      };
    }

    setImageUrl(null);

    const isbn = book.isbn?.trim();

    if (isbn) {
      setImageUrl(
        `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(isbn)}-L.jpg?default=false`
      );
    }

    const query = encodeURIComponent(
      `intitle:${book.title} inauthor:${book.author}`
    );

    fetch(
      `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=1`
    )
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        const thumbnail =
          data?.items?.[0]?.volumeInfo?.imageLinks?.thumbnail ||
          data?.items?.[0]?.volumeInfo?.imageLinks?.smallThumbnail;

        if (!cancelled && !book.cover_image && thumbnail) {
          setImageUrl(
            String(thumbnail).replace('http://', 'https://')
          );
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [book.id, book.cover_image, book.isbn, book.title, book.author]);

  return (
    <div
      className={`${className} cover-${index % 5}`}
      aria-label={`Cover image for ${book.title}`}
      style={{
        position: 'relative',
        overflow: 'hidden',
        backgroundColor: '#f7f1e3',
        ...(className.includes('book-cover-detail')
          ? {
              width: '100%',
              height: '100%',
              minWidth: 0,
              minHeight: 0,
              flex: 'none',
              margin: 0
            }
          : {}),
      }}
    >
      {imageUrl && !imageFailed ? (
        <img
          src={imageUrl}
          alt={`Cover of ${book.title}`}
          loading={
            className.includes('book-cover-detail')
              ? 'eager'
              : 'lazy'
          }
          onError={() => setImageFailed(true)}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            maxWidth: 'none',
            objectFit: 'contain',
            objectPosition: 'center center',
            transform: 'none',
            transformOrigin: 'center',
            backgroundColor: '#f7f1e3',
            display: 'block',
            borderRadius: 'inherit',
          }}
        />
      ) : (
        <>
          <span className="cover-brand">LIBTRACK PICKS</span>
          <span className="cover-title">{book.title}</span>
          <span className="cover-rule" />
          <span className="cover-author">
            <AuthorDisplay book={book} />
          </span>
          <span className="cover-decoration">✦</span>
        </>
      )}
    </div>
  );
}


// Resolve missing author metadata from Google Books at display time.
// A result is accepted only when its title closely matches the catalog title.
const authorLookupCache = new Map<string, string>();

function normalizeBookTitle(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !['the', 'and', 'for', 'with', 'second', 'edition'].includes(word));
}

function hasMatchingBookTitle(requested: string, candidate: string): boolean {
  const requestedWords = normalizeBookTitle(requested);
  const candidateWords = new Set(normalizeBookTitle(candidate));
  if (!requestedWords.length || !candidateWords.size) return false;
  const matched = requestedWords.filter((word) => candidateWords.has(word)).length;
  return matched / requestedWords.length >= 0.9;
}

function AuthorDisplay({ book, prefix = '' }: { book: Book; prefix?: string }) {
  const [author, setAuthor] = useState<string>(() => {
    const current = (book.author || '').trim();
    const isPlaceholder = !current || /needs edition|not listed|unknown|not available|author not verified/i.test(current);
    return isPlaceholder ? '' : current;
  });
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const current = (book.author || '').trim();
    const isPlaceholder = !current || /needs edition|not listed|unknown|not available|author not verified/i.test(current);

    if (!isPlaceholder) {
      setAuthor(current);
      setChecked(true);
      return () => { cancelled = true; };
    }

    const cacheKey = book.title.trim().toLowerCase();
    const cached = authorLookupCache.get(cacheKey);
    if (cached) {
      setAuthor(cached);
      setChecked(true);
      return () => { cancelled = true; };
    }

    setAuthor('');
    setChecked(false);

    const query = encodeURIComponent(`intitle:"${book.title}"`);
    fetch(`https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=10&printType=books`)
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (cancelled) return;
        const items = Array.isArray(data?.items) ? data.items : [];
        const match = items.find((item: any) =>
          hasMatchingBookTitle(book.title, String(item?.volumeInfo?.title || ''))
          && Array.isArray(item?.volumeInfo?.authors)
          && item.volumeInfo.authors.length > 0
        );
        const foundAuthors = match?.volumeInfo?.authors?.filter((name: unknown) =>
          typeof name === 'string' && name.trim()
        );
        if (foundAuthors?.length) {
          const result = foundAuthors.join(', ');
          authorLookupCache.set(cacheKey, result);
          setAuthor(result);
        }
        setChecked(true);
      })
      .catch(() => {
        if (!cancelled) setChecked(true);
      });

    return () => { cancelled = true; };
  }, [book.id, book.title, book.author]);

  return (
    <span className="book-author">
      {prefix}{author || (checked ? 'Author not verified' : 'Finding author…')}
    </span>
  );
}

type MostBorrowedBook = Book & {
  borrow_count: number;
};

type MostBorrowingStudent = {
  id: number;
  full_name: string;
  student_id?: string | null;
  course?: string | null;
  year?: string | null;
  section?: string | null;
  borrow_count: number;
};

type AuthUser = {

  id?: number;

  full_name?: string;

  name?: string;

  email?: string;

  role?: string;

  student_id?: string | null;

  username?: string | null;

  course?: string | null;

  year?: string | null;

  section?: string | null;
  profile_photo_url?: string | null;

};

type Account = {

  id: number;

  full_name: string;

  student_id?: string | null;

  course?: string | null;

  year?: string | null;

  section?: string | null;

  username?: string | null;

  profile_photo_url?: string | null;

  email: string;

  role: string;

  active: boolean;

};

type Borrowing = {
  id: number;
  user_id: number;
  book_id: number;
  borrowed_at?: string | null;
  due_date: string;
  returned_at?: string | null;
  status: string;
  overdue?: boolean;
};

type LostBookCase = {
  id: number;
  borrowing_id: number;
  user_id: number;
  book_id: number;
  report_date: string;
  market_value: number;
  processing_fee: number;
  additional_fine: number;
  amount_due: number;
  deadline: string;
  case_type: string;
  resolution_status: string;
  resolution_note?: string | null;
  resolved_at?: string | null;
};

type UserNotification = {
  id: number;
  title: string;
  message: string;
  notification_type: string;
  is_read: boolean;
  created_at?: string | null;
};

type LoginSession = {

  user_id: number;

  full_name: string;

  email: string;

  role: string;

  status: string;

  login_at: string;

  last_seen: string;

};

type Page =

  | 'home'

  | 'categories'

  | 'books'

  | 'research'

  | 'ebooks'
  | 'inventory'

  | 'borrowingStats'

  | 'borrowings'

  | 'lostBooks'

  | 'sessions'

  | 'accounts'

  | 'profile'
  | 'settings'
  | 'admin-connection'
  | 'admin-borrowing-schedule'
  | 'admin-library-schedule'
  | 'admin-weekend-notice'
  | 'admin-password'
  | 'admin-problem-reports'
  | 'user-password'
  | 'user-notifications'
  | 'user-about'
  | 'user-guidelines'
  | 'user-support'
  | 'user-report'
  | 'user-privacy'
  | 'user-library-schedule'
  | 'user-requests'
  | 'user-saved-books'
  | 'user-preferences';

type ResearchView = 'collections' | 'course' | 'reader';

type ResearchMaterial = {
  id: number;
  title: string;
  authors: string;
  teacher?: string | null;
  year: string;
  course: string;
  subject: string;
  research_type?: string;
  abstract?: string | null;
  verification_status?: string;
  campus: string;
  url: string;
  note?: string | null;
  has_pdf?: boolean;
  pdf_url?: string | null;
  cover_image?: string | null;
};

type EBook = {
  id: string;
  title: string;
  file_name: string;
  author: string;
  category: string;
  description?: string;
  thumbnail_url?: string;
  preview_url: string;
  modified_time?: string;
  size?: string;
  course?: string;
  year?: string;
  semester?: string;
  subject?: string;
  folder_path?: string;
};

// BSIT subject folders transcribed from the user's supplied folder screenshots.
const BSIT_EBOOK_SUBJECTS: Record<string, Record<string, string[]>> = {
  '1ST YEAR CICT': {
    '1st Semester': ['CC-100', 'CC-101', 'FIL 1', 'GE 4', 'GE 5', 'GE 7', 'IT-NET01', 'NSTP 11', 'PE 1'],
    '2nd Semester': ['CC-102', 'FIL 2', 'GE 01', 'GE 02', 'IT-WS01', 'NSTP 12', 'PE 2'],
  },
  '2ND YEAR CICT': {
    '1st Semester': ['CC-103', 'FIL 3', 'GE 6', 'GE 8', 'IT-PE01', 'IT-WS02'],
    '2nd Semester': ['CC104', 'CC105', 'GE 09', 'IT-HC101', 'IT-MS02', 'IT-PF02', 'PE 4'],
  },
  '3RD YEAR CICT': {
    '1st Semester': ['ELP', 'IT-IAS01', 'IT-IM01', 'IT-IPT01', 'IT-IPT02', 'IT-SA01'],
    '2nd Semester': ['IT-CAP01', 'IT-IAS02', 'IT-WS03', 'IT-WS04', 'IT-WS05'],
  },
  '4TH YEAR CICT': {
    '1st Semester': ['IT-CAP02', 'IT-SIA01', 'IT-SP01', 'IT-WS06', 'IT-WS07'],
    // No 4th-year 2nd-semester subject folders were visible in the supplied screenshots.
    '2nd Semester': [],
  },
};

// BSBA subject folders transcribed from the user's CMBT E-Books screenshots.
// Only folder names that are readable in the supplied screenshots are included.
const BSBA_EBOOK_SUBJECTS: Record<string, Record<string, string[]>> = {
  '1ST YEAR BSBA': {
    '1st Semester': [
      'BASIC MICROECONOMICS', 'PATHFIT 1', 'READING IN THE PHILIPPINE HISTORY',
      'MATHEMATICS IN THE MODERN WORLD', 'NSTP 1', 'UNDERSTANDING THE SELF',
      'THE CONTEMPORARY WORLD', 'KONTEKSTWALISADONG KOMUNIKASYON SA FILIPINO',
      'ADVANCED GYMNASTIC', 'PURPOSIVE COMMUNICATION',
    ],
    '2nd Semester': [
      'NSTP 2', 'ELECTIVE 2', 'BA CORE 2', 'ELECTIVE 1',
      'RHYTHMIC ACTIVITIES FOLKDANCE (SOCIAL DANCE)', 'ART APPRECIATION',
      'SCIENCE TECHNOLOGY AND SOCIETY', 'FIL 2', 'ETHICS',
    ],
  },
  '2ND YEAR BSBA': {
    '1st Semester': [
      'AGRICULTURAL MARKETING', 'TAXATION', 'HUMAN RESOURCE MANAGEMENT',
      'FIL 3', 'PE 3', 'BUSINESS LAW', 'ELECTIVE 3', 'THE LIFE AND WORK OF RIZAL',
    ],
    '2nd Semester': [
      'ENGLISH FOR BUSINESS ADMINISTRATION', 'CONSUMER BEHAVIOR', 'SALES MANAGEMENT',
      'NEW MARKET DEVELOPMENT', 'DIRECT MARKETING', 'STRATEGIC MANAGEMENT',
      'BA CORE 6', 'PE 4', 'ELECTIVE 7',
    ],
  },
  '3RD YEAR BSBA': {
    '1st Semester': [
      'MARKETING MANAGEMENT', 'DISTRIBUTION MANAGEMENT', 'ADVERTISING',
      'BUSINESS RESEARCH', 'PROFESSIONAL SALESMANSHIP',
      'SPECIAL TOPICS IN MARKETING MANAGEMENT',
    ],
    '2nd Semester': [
      'RETAIL MANAGEMENT', 'OPERATION MANAGEMENT', 'MARKETING RESEARCH',
      'ELECTIVE 12', 'ELECTIVE 11', 'PRODUCT MANAGEMENT',
    ],
  },
  '4TH YEAR BSBA': {
    '1st Semester': ['PROF. 8', 'ELECTIVE 14', 'BA CORE 8', 'ELECTIVE 13'],
    '2nd Semester': ['PRACTICUM WORK INTEGRATED LEARNING'],
  },
};

// BSED subject folders transcribed from the user's supplied folder screenshots.
const BSED_EBOOK_SUBJECTS: Record<string, Record<string, string[]>> = {
  '1ST YEAR BSED': {
    '1st Semester': ['PATHFIT 1', 'PROF ED 2', 'NSTP 1', 'GEN ED 2', 'PE 1', 'GEN ED 1', 'GEN ED 5', 'PROF ED 1', 'FIL1', 'GEN ED 4'],
    '2nd Semester': ['SEE 2', 'SEE 4', 'SEE 1', 'PROF ED 3', 'NSTP 2', 'SEE 3', 'PE 2', 'FIL 2'],
  },
  '2ND YEAR BSED': {
    '1st Semester': ['SEE 5', 'PE 3', 'PROF ED 4', 'PROF ED 5', 'PROF ED 6', 'SEE 7', 'GEN ED 10'],
    '2nd Semester': ['SEE 8', 'SEE 10', 'SEE 12', 'PROF ED 7', 'PROF ED 8', 'PROF ED 9', 'SEE 9', 'SEE 11', 'PE 4'],
  },
  '3RD YEAR BSED': {
    '1st Semester': ['SEE 14', 'SEE 18', 'SEE 15', 'SEE 17', 'PROF ED 10', 'SEE 13', 'SEE 19', 'SEE 16'],
    '2nd Semester': ['ELP', 'SEE 22', 'SEE 23', 'SEE 20', 'SEE 24'],
  },
  '4TH YEAR BSED': {
    '1st Semester': ['PROF ED 12', 'PROF ED 13', 'GEN ED 3', 'GEN ED 8', 'GEN ED 7', 'GEN ED 6'],
    '2nd Semester': ['PROF ED 14'],
  },
};

function getEbookSubjects(course: string, year: string, semester: string): string[] {
  if (course === 'BSIT') return BSIT_EBOOK_SUBJECTS[year]?.[semester] || [];
  if (course === 'BSBA') return BSBA_EBOOK_SUBJECTS[year]?.[semester] || [];
  if (course === 'BSED') return BSED_EBOOK_SUBJECTS[year]?.[semester] || [];
  return [];
}

const RESEARCH_COURSE_OPTIONS = [
  { value: 'BSIT', shortName: 'BSIT', label: 'BSIT · Information Technology', description: 'Programming, AI, hardware, systems, and technology research' },
  { value: 'BSBA', shortName: 'BSBA', label: 'BSBA · Business Administration', description: 'Marketing, small business, and feasibility studies' },
  { value: 'BSED', shortName: 'BSEd', label: 'BSED · Education', description: 'One combined collection for BSED, Elementary Education, English Education, and MAPEH research' },
];

/**
 * Keep historic course values grouped under the single BSED collection in the UI.
 * This is a display/filter mapping only; it does not rewrite or delete database rows.
 */
function getResearchCollectionKey(course: string | null | undefined): string {
  const normalized = String(course ?? '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const isBsedFamily =
    normalized === 'BSED' || normalized.startsWith('BSED-') ||
    normalized === 'BEED' || normalized.startsWith('BEED-') ||
    normalized === 'ELEMENTARY' || normalized === 'ELEMENTARY-EDUCATION' ||
    normalized.includes('ELEMENTARY-EDUCATION') ||
    normalized === 'ENGLISH' || normalized === 'ENGLISH-EDUCATION' ||
    normalized === 'MAPEH' || normalized.includes('MUSIC-ARTS') ||
    normalized.includes('PHYSICAL-EDUCATION-AND-HEALTH');

  return isBsedFamily ? 'BSED' : normalized;
}

async function readResponse(response: Response): Promise<any> {

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {

    const detail = data?.detail;

    const message =

      typeof detail === 'string'

        ? detail

        : Array.isArray(detail)

          ? detail.map((item: { msg?: string }) => item.msg || '')

              .filter(Boolean)

              .join(', ')

          : `Request failed (${response.status})`;

    throw new Error(message || `Request failed (${response.status})`);

  }

  return data;

}

function getError(err: unknown): string {

  if (err instanceof TypeError) {

    return `Cannot reach the API (${API}). Make sure the backend is running and VITE_API_URL is correct.`;

  }

  return err instanceof Error

    ? err.message

    : 'An unexpected error occurred. Please try again.';

}

async function libtrackPrompt(
  message: string,
  defaultValue = '',
  inputType: 'text' | 'number' | 'date' | 'url' = 'text',
): Promise<string | null> {
  const dialog = await alertController.create({
    cssClass: 'libtrack-alert libtrack-danger-alert',
    header: 'LibTrack',
    message,
    inputs: [{
      name: 'value',
      type: inputType,
      value: defaultValue,
      placeholder: inputType === 'date' ? 'Choose a date' : 'Enter a value',
      attributes: inputType === 'number' ? { min: 1, inputmode: 'numeric' } : undefined,
    }],
    buttons: [
      { text: 'Cancel', role: 'cancel', cssClass: 'libtrack-dialog-cancel' },
      { text: 'Save', role: 'confirm', cssClass: 'libtrack-dialog-confirm' },
    ],
    backdropDismiss: false,
  });
  await dialog.present();
  const { data, role } = await dialog.onDidDismiss();
  if (role !== 'confirm') return null;
  const value = data?.values?.value;
  return value == null ? '' : String(value);
}

async function libtrackTextAreaPrompt(
  message: string,
  defaultValue = '',
): Promise<string | null> {
  const dialog = await alertController.create({
    cssClass: 'libtrack-alert',
    header: 'Edit Book Description',
    message,
    inputs: [{
      name: 'value',
      type: 'textarea',
      value: defaultValue,
      placeholder: 'Write the book description in English',
      attributes: { rows: 8, maxlength: 5000 },
    }],
    buttons: [
      { text: 'Cancel', role: 'cancel', cssClass: 'libtrack-dialog-cancel' },
      { text: 'Save', role: 'confirm', cssClass: 'libtrack-dialog-confirm' },
    ],
    backdropDismiss: false,
  });
  await dialog.present();
  const { data, role } = await dialog.onDidDismiss();
  if (role !== 'confirm') return null;
  const value = data?.values?.value;
  return value == null ? '' : String(value);
}

async function libtrackNotice(title: string, message: string): Promise<void> {
  const dialog = await alertController.create({
    cssClass: 'libtrack-alert libtrack-success-alert',
    header: title,
    message,
    buttons: [{ text: 'Done', role: 'confirm', cssClass: 'libtrack-dialog-confirm' }],
    backdropDismiss: false,
  });
  await dialog.present();
  await dialog.onDidDismiss();
}

async function libtrackConfirm(message: string): Promise<boolean> {
  const dialog = await alertController.create({
    cssClass: 'libtrack-alert libtrack-confirm-alert',
    header: 'LibTrack',
    message,
    buttons: [
      { text: 'Cancel', role: 'cancel', cssClass: 'libtrack-dialog-cancel' },
      { text: 'Continue', role: 'confirm', cssClass: 'libtrack-dialog-confirm' },
    ],
    backdropDismiss: false,
  });
  await dialog.present();
  const { role } = await dialog.onDidDismiss();
  return role === 'confirm';
}

function cleanCategoryLabel(value: string): string {
  return String(value || '').replace(/^\s*\d+\s*[.)\]:\-–—]\s*/, '').trim();
}

function getBookAbout(book: Book): string {
  // About text is generated from each catalog record so old repeated or generic
  // database descriptions do not override the refreshed book introductions.
  const title = book.title.trim();
  const author = (book.author || 'the listed author').trim();
  const category = cleanCategoryLabel((book.category || 'General').trim());
  const normalizedTitle = title.toLowerCase().replace(/\s+/g, ' ').trim();
  const normalizedCategory = category.toLowerCase();

  // Book-specific summaries for titles whose contents are well established.
  // Keep these summaries paraphrased rather than reproducing book text.
  const bookIntroductions: Record<string, string> = {
    'the little prince': 'A young prince travels from his tiny asteroid to different worlds, meeting unusual adults along the way. Through his journey and his friendship with a pilot stranded in the desert, the story invites readers to think about love, friendship, responsibility, and what gives life real meaning.',
    'to kill a mockingbird': 'In a small Southern town during the 1930s, young Scout Finch watches her father, Atticus, defend a Black man accused of a crime he did not commit. As Scout and her brother Jem encounter prejudice and injustice, they begin to understand empathy, courage, and the importance of seeing the world from another person’s point of view.',
    'the great gatsby': 'Nick Carraway moves to Long Island and becomes drawn into the glittering world of his wealthy neighbor, Jay Gatsby. Behind Gatsby’s lavish parties is his longing to reunite with Daisy Buchanan, and the novel gradually reveals the cost of chasing an idealized past amid wealth, status, and social divisions.',
    '1984': 'Winston Smith lives in a society where the Party watches its citizens, controls information, and demands unquestioning loyalty to its leader, Big Brother. As Winston begins to question the official version of reality, he struggles to protect his own thoughts and discover whether truth and freedom can survive under constant control.',
    'pride and prejudice': 'Elizabeth Bennet navigates family expectations and social pressures in a society where marriage affects a woman’s future. Her first impressions of the proud Mr. Darcy lead to misunderstandings, but as both characters learn more about one another, they are challenged to reconsider their judgments, pride, and prejudices.',
    'the alchemist': 'Santiago, a young shepherd, dreams of finding treasure near the Egyptian pyramids. He leaves familiar surroundings and follows a journey that brings him across deserts, introduces him to unexpected teachers, and encourages him to listen to his heart while learning what his goal means to him.',
    'atomic habits': 'James Clear explains how small, repeated actions can gradually shape everyday behavior. The book introduces practical ways to build helpful habits, make unwanted habits harder to follow, and create routines that support long-term improvement instead of relying only on motivation.',
  };

  const researchedBookIntroductions: Record<string, string> = {
    "filipino i: wikang filipino sa akademikong komunikasyon": "This book explores the use of Filipino in academic communication, including clear expression, reading, writing, and producing texts suited to academic work.",
    "alab ng wikang filipino": "This book focuses on understanding and valuing the Filipino language. It introduces the language’s uses, development, and role in education and society.",
    "sikolohiya ng wikang filipino": "This book examines the relationship between language and thought in Filipino contexts, including how people use language to understand ideas, interact, and create meaning.",
    "mabisang retorika sa wikang filipino": "This book introduces effective rhetoric in Filipino, including building clear arguments, organizing ideas, and choosing language appropriate for different audiences.",
    "binhi 1: filipino — wikang pangkomunikatibo": "This book presents Filipino as a tool for communication and learning. It supports the development of comprehension and expression across different communication situations.",
    "panitikan ng pilipinas": "This book introduces Philippine literature and the works, forms, and themes that reflect Filipino experiences, culture, and history.",
    "noli me tangere": "José Rizal’s novel portrays Philippine society under Spanish colonial rule through Crisostomo Ibarra’s return and encounters that expose abuse, privilege, and injustice.",
    "el filibusterismo": "The sequel to Noli Me Tangere follows Simoun and his plan to change an oppressive society. It explores revenge, power, reform, and the consequences of oppression.",
    "florante at laura": "Francisco Balagtas’s poem tells of Florante’s suffering and love for Laura amid betrayal and turmoil in the kingdom. Through allegory, it explores love, loyalty, and justice.",
    "ibong adarna": "This classic metrical romance follows the search for the magical Adarna bird and the trials faced by three prince brothers. Its themes include courage, loyalty, envy, and forgiveness.",
    "dekada '70": "Lualhati Bautista’s novel follows a Filipino family during the Martial Law era. Through Amanda Bartolome’s perspective, it explores family change, women’s roles, activism, and human rights.",
    "bata, bata... pa'no ka ginawa?": "The novel follows Lea, a working mother who faces social expectations about women and parenting. It explores family, identity, and personal choice.",
    "masining na pagpapahayag": "This book focuses on developing expressive and effective communication. Topics include word choice, sentence construction, and presenting ideas in spoken and written forms.",
    "ang wikang pambansa sa panahon ng pagbabago": "This title examines the national language amid social and educational change. Its subject includes the formation, spread, and continuing development of Filipino.",
    "kasaysayan at pag-unlad ng panitikang pilipino": "This book examines the emergence and transformation of Philippine literature across different periods, highlighting literary forms and the influence of history and society on written works.",
    "pagsusuri ng akdang pampanitikan": "This book guides readers in analyzing literature through its themes, characters, setting, structure, language, and historical or cultural context.",
    "panitikang rehiyonal sa pilipinas": "This book highlights literature from different Philippine regions and the languages, traditions, experiences, and perspectives that shape local writing.",
    "gramatika at pagbuo ng pangungusap": "This book explains grammatical rules and how words can be combined to form clear, correct sentences.",
    "balagtas: ang buhay at mga akda": "This book explores Francisco Balagtas’s life and contribution to Filipino literature, including works associated with his legacy and their literary significance.",
    "wika at lipunan": "This book examines the relationship between language and society, including how culture, identity, community, and social situations influence language use.",
    "building and enhancing new literacies across the curriculum": "This book explores the development of multiple literacies across school subjects, including skills students need to understand and use information in a changing world.",
    "arts integration and special education": "This book discusses ways to integrate the arts into teaching and learning for students with diverse needs, supporting participation, learning, and self-expression.",
    "beginnings & beyond: foundations in early childhood education": "This book introduces the foundations of early childhood education, including child development, learning environments, and age-appropriate educational experiences.",
    "information skills for education students": "This guide helps education students find, evaluate, use, and cite information for academic assignments and research.",
    "toward a civil society: civic literacy and service learning": "This book connects civic knowledge with community participation and service learning to explore responsibility, collaboration, and social issues.",
    "the teacher and the community, school culture and organizational leadership": "This book examines relationships among teachers, schools, and communities, along with school culture and leadership and organizational concepts in education.",
    "teach like a champion": "This book presents teaching and classroom-management strategies focused on clear directions, active student participation, and strong learning routines.",
    "transformational leadership in special education": "This book explores leadership that supports improvement and change in special education, including support for teachers, students, families, and institutions.",
    "the exceptional child: inclusion in early childhood education": "This book focuses on including children with diverse abilities and needs in early childhood education and on principles that support inclusive learning.",
    "classroom management: preparing special education teachers": "This guide helps special education teachers create safe, orderly classrooms, set clear expectations, and respond to students’ varied learning needs.",
    "introduction to special education": "This book introduces special education, including diverse learning needs, support services, and principles that guide inclusion.",
    "educational psychology": "This book examines how students learn and develop and how teachers can apply concepts of motivation, cognition, development, and assessment in instruction.",
    "job satisfaction among non-teaching personnel": "This title focuses on job satisfaction among non-teaching staff and the workplace factors that may influence employees’ experiences and attitudes.",
    "curriculum development and evaluation": "This book discusses curriculum planning, design, implementation, and evaluation to determine whether learning goals and student needs are being met.",
    "principles of teaching": "This book explains key principles of teaching, including lesson planning, strategy selection, student participation, and assessment of learning.",
    "child and adolescent development": "This book examines physical, cognitive, emotional, and social development from childhood through adolescence, providing context for understanding learners.",
    "facilitating learner-centered teaching": "This book focuses on learner-centered teaching through activities that encourage participation, reflection, collaboration, and independent learning.",
    "assessment of student learning": "This book explores ways to measure and understand student learning, design assessments, provide feedback, and use results to improve instruction.",
    "classroom instruction that works": "This book presents research-informed teaching strategies intended to deepen understanding, organize knowledge, and monitor student progress.",
    "the teaching profession": "This book surveys the teaching profession, including teachers’ roles, professional standards, ethics, and responsibilities to schools and communities.",
    "ethics in the teaching profession": "This book discusses ethical principles for teachers, including fairness, accountability, respect for students, confidentiality, and professional conduct.",
    "measurement and evaluation in education": "This guide covers educational measurement and evaluation, including tests, interpretation of results, validity, reliability, and evidence-based decisions about learning.",
    "curriculum and instruction": "This book connects curriculum design with teaching methods and shows how learning goals can be translated into classroom experiences.",
    "curriculum development: theory and practice": "This book explores theories and practical steps for curriculum development, from planning and design to implementation and evaluation.",
    "introduction to educational research": "This book introduces the foundations of educational research, including developing research questions, choosing a design, collecting and analyzing data, and reporting findings.",
    "calculus: an applied approach": "This book explains calculus concepts through applications, including change, rates, and mathematical modeling of real-world problems.",
    "multivariable calculus": "This book covers calculus for functions of several variables, including partial derivatives, multiple integrals, and applications in advanced mathematics.",
    "differential calculus: made easy": "This book introduces the core ideas of differential calculus, especially limits, derivatives, and the use of rates of change to solve problems.",
    "differential calculus": "This book introduces limits and derivatives and their use in studying change, tangent slopes, optimization, and other mathematical problems.",
    "python programming: an introduction": "This book introduces programming with Python, including variables, control flow, functions, data structures, and building simple programs.",
    "database system concepts": "This book covers core database-system concepts, including data modeling, relational databases, SQL, transactions, and data management.",
    "computer science: an overview": "This book provides a broad introduction to computer science, from hardware and software to algorithms, data, networks, and foundational computing concepts.",
    "java: how to program": "This guide teaches Java programming, including syntax, object-oriented programming, classes, control structures, and building and testing applications.",
    "calculus: early transcendentals": "This book covers differential and integral calculus, including functions, limits, derivatives, integrals, and transcendental functions such as exponential, logarithmic, and trigonometric functions.",
    "mathematical analysis": "This book focuses on rigorous foundations of calculus and analysis, including limits, continuity, sequences, series, and mathematical proofs.",
    "physics for scientists and engineers": "This book explains core physics concepts and mathematical reasoning used to study motion, forces, energy, waves, and other physical systems.",
    "chemistry: the central science": "This book introduces foundational chemistry concepts, including atoms, chemical bonding, reactions, stoichiometry, thermodynamics, and connections between chemistry and other sciences.",
    "biology: concepts and connections": "This book introduces key biological concepts and their relationships, including cells, genetics, evolution, ecology, and living systems.",
    "engineering mechanics": "This book covers engineering mechanics, especially the analysis of forces and motion used to solve technical problems.",
    "electronic devices and circuit theory": "This book combines the study of electronic devices with circuit analysis, including semiconductor components and the behavior of electrical circuits.",
    "computer networks": "This book explains how computers communicate through networks, covering protocols, network architecture, data transmission, and core security concepts.",
    "c++: the complete reference": "This reference covers C++ programming, including language features, object-oriented programming, the standard library, and software development techniques.",
    "statistics for business and economics": "This book explains statistical methods used in business and economics, including data summaries, probability, estimation, hypothesis testing, and interpretation.",
    "engineering electromagnetics": "This book covers electromagnetic fields and waves, including electric and magnetic fields and their engineering applications.",
    "principles of biochemistry": "This book explains the molecules and chemical reactions behind living processes, including proteins, enzymes, metabolism, and cellular information.",
    "anatomy & physiology": "This book studies the structure of the human body and how its organs and systems function, linking anatomy with physiology.",
    "artificial intelligence: a modern approach": "This comprehensive introduction to artificial intelligence covers intelligent agents, search, knowledge representation, reasoning, machine learning, and other core AI methods.",
    "a first course in abstract algebra": "This book introduces abstract algebra through structures such as groups, rings, and fields, emphasizing definitions, examples, proofs, and algebraic reasoning.",
    "optimal control and estimation": "This book covers mathematical methods for choosing optimal controls for a system and estimating its state from observations or data.",
    "the practice of programming": "This book focuses on sound programming principles, including simplicity, clear design, debugging, testing, and maintainable software.",
    "the history of the filipino people": "This book examines major periods in Filipino history, including pre-colonial society, colonialism, nationalism, and the formation of the modern nation.",
    "philippine history": "This book surveys Philippine history and the people, events, and changes that shaped the country’s society and government.",
    "the philippines: a past revisited": "This book re-examines Philippine history through documents and interpretations, encouraging readers to question and evaluate accounts of the past.",
    "barangay: sixteenth-century philippine culture": "This book describes society and culture in the Philippine archipelago during the sixteenth century, using historical sources to examine daily life, social relationships, and institutions.",
    "principles of economics": "This book introduces core economic ideas, including supply and demand, choices under scarcity, markets, production, and the role of institutions.",
    "fiscal administration": "This book discusses public financial management, including taxation, government spending, budgeting, and accountability for public funds.",
    "global dimensions of public administration": "This book examines public administration in a global context, including globalization, governance, public policy, and challenges in delivering public services.",
    "governing: an introduction to political science": "This book introduces government and political science, including power, institutions, ideologies, participation, and policy-making.",
    "invitation to sociology": "This book introduces sociology and the study of groups, institutions, culture, inequality, and the ways society shapes human experience.",
    "labor economics": "This book examines labor markets, including wages, employment, labor supply and demand, investment in skills, and employment-related policies.",
    "malolos: the crisis of the republic": "This book examines conflicts and challenges in the First Philippine Republic and the difficulties its leaders faced while establishing an independent government.",
    "introduction to philippine law": "This book introduces the Philippine legal system, basic legal concepts, and the institutions responsible for applying and interpreting the law.",
    "social research methods": "This book explains methods for conducting social research, including question development, research design, sampling, data collection, analysis, and ethics.",
    "economic development": "This book examines the processes and challenges of economic development, including poverty, growth, institutions, education, and policies that affect livelihoods.",
    "imagined communities": "Benedict Anderson explains how a nation can be understood as an “imagined community” and examines the roles of language, print media, and history in shaping nationalism.",
    "the modern researcher": "This guide covers the research process, from finding and evaluating sources to developing arguments, citing evidence, and writing academic papers.",
    "public administration: concepts and cases": "This book combines key public-administration concepts with cases that illustrate how government, organizations, and public services operate.",
    "the interpretation of cultures": "Clifford Geertz presents an interpretive approach to anthropology and explores how culture can be understood through symbols, practices, and the meanings people assign to them.",
    "the economics of money, banking, and financial markets": "This book explains the roles of money, banks, financial markets, and monetary policy, including interest rates, risk, and financial institutions.",
    "the philippine islands": "This title concerns accounts and descriptions of the Philippine archipelago. The edition and table of contents should be checked to establish its exact scope, period, and perspective.",
    "corrections & restorative justice": "This book examines correctional systems and restorative justice, with attention to accountability, repairing harm, and involving people affected by wrongdoing.",
    "comprehensive penology": "This book surveys penology—the study of punishment, imprisonment, rehabilitation, and the goals and methods of correctional systems.",
    "polygraphy: lie detection": "This title discusses the polygraph and its use in attempting to assess physiological responses during questioning. It is important to consider the method’s limitations and controversies when interpreting evidence.",
    "criminal law and jurisprudence": "This book examines principles of criminal law and jurisprudence, including elements of offenses, criminal responsibility, and legal interpretation.",
    "introduction to criminology": "This book introduces criminology, the study of crime, its causes and effects, behavior, crime prevention, and society’s responses through the justice system.",
    "principles of criminology": "This book covers key criminological theories and concepts, including the study of crime, related factors, and approaches to prevention and control.",
    "evidence and criminal procedure": "This book introduces rules of evidence and stages of criminal procedure, including how evidence is obtained, presented, and assessed under applicable law.",
    "criminal investigation": "This book covers principles and processes of criminal investigation, including developing leads, documenting information, and carefully evaluating evidence.",
    "police organization and planning": "This book examines the organization, management, and planning of police agencies, including roles, structures, and resource allocation.",
    "penal philosophy": "This book examines rationales for punishment, including deterrence, retribution, rehabilitation, and other aims of the criminal justice system.",
    "juvenile delinquency and crime prevention": "This book examines youth offending, factors associated with it, and prevention and response approaches focused on young people and their communities.",
    "public safety and security management": "This book covers planning and management for public safety and security, including risk assessment, coordination, preparedness, and incident response.",
    "constitutional law and human rights": "This book explains constitutional principles and human rights, including government powers, citizens’ rights, and limits on the exercise of authority.",
    "forensic science": "This book introduces scientific methods used to examine evidence relevant to investigations, emphasizing careful documentation and interpretation of findings.",
  };

  const knownIntroduction = bookIntroductions[normalizedTitle] || researchedBookIntroductions[normalizedTitle];
  if (knownIntroduction) return knownIntroduction;

  // For titles without a verified book-specific summary, create a distinct
  // introduction using the actual title, author, and catalog category. Avoid
  // inventing plot details, chapter contents, or claims about a particular edition.
  const subject = title.replace(/[“”]/g, '').trim();
  if (
    normalizedCategory.includes('fiction') || normalizedCategory.includes('novel') ||
    normalizedCategory.includes('literature') || normalizedCategory.includes('fantasy') ||
    normalizedCategory.includes('romance') || normalizedCategory.includes('mystery') ||
    normalizedCategory.includes('adventure') || normalizedCategory.includes('poetry')
  ) {
    return `“${subject}” by ${author} is included in LibTrack’s ${category} collection. This title invites readers to engage with its literary style, ideas, and perspective. As you read, consider how the author develops the subject, uses language, and connects the work’s details to its larger themes.`;
  }
  if (
    normalizedCategory.includes('science') || normalizedCategory.includes('technology') ||
    normalizedCategory.includes('computer') || normalizedCategory === 'it' ||
    normalizedCategory.includes('engineering') || normalizedCategory.includes('mathematics')
  ) {
    return `“${subject}” by ${author} is part of LibTrack’s ${category} collection. It offers a subject-focused resource for exploring the principles and ideas associated with ${subject}. Use the book’s contents and examples to identify its key concepts, understand how they are explained, and connect them with your coursework and further study.`;
  }
  if (
    normalizedCategory.includes('history') || normalizedCategory.includes('social') ||
    normalizedCategory.includes('politic') || normalizedCategory.includes('culture')
  ) {
    return `“${subject}” by ${author} belongs to LibTrack’s ${category} collection. The title provides a starting point for examining the people, events, institutions, or social ideas connected with this subject. While reading, consider the context and perspective presented by the author and how they shape an understanding of the topic.`;
  }
  if (
    normalizedCategory.includes('business') || normalizedCategory.includes('management') ||
    normalizedCategory.includes('econom') || normalizedCategory.includes('account') ||
    normalizedCategory.includes('marketing') || normalizedCategory.includes('finance')
  ) {
    return `“${subject}” by ${author} is a resource in LibTrack’s ${category} collection. It introduces a business-related subject for readers interested in organizations, decisions, markets, or professional practice. Focus on the approaches and examples presented in the book and consider how its ideas may apply to business studies and real-world situations.`;
  }
  if (
    normalizedCategory.includes('education') || normalizedCategory.includes('teaching') ||
    normalizedCategory.includes('language') || normalizedCategory.includes('learning')
  ) {
    return `“${subject}” by ${author} is included in LibTrack’s ${category} collection for learners and educators. The title points to an area of study that can be explored through the author’s explanations and examples. Consider how the ideas relate to communication, learning, classroom practice, or the development of knowledge in this field.`;
  }
  if (
    normalizedCategory.includes('health') || normalizedCategory.includes('medicine') ||
    normalizedCategory.includes('nursing') || normalizedCategory.includes('biology')
  ) {
    return `“${subject}” by ${author} is part of LibTrack’s ${category} collection. This title provides a starting point for studying the health or life-science subject named in the book. Review the author’s explanations and supporting information carefully, and use the table of contents to identify the specific areas covered in this edition.`;
  }
  return `“${subject}” by ${author} is part of LibTrack’s ${category} collection. This book gives readers a focused starting point for exploring the subject identified by its title. Review the opening section and table of contents to understand the author’s purpose, the topics included, and how the material can support your studies.`;
}


// Automatically look up a matching book description so the Admin does not
// have to enter the About text manually for every catalog record.
const bookAboutLookupCache = new Map<string, string | null>();

function BookAbout({ book }: { book: Book }) {
  const [about, setAbout] = useState<string>(() => getBookAbout(book));

  useEffect(() => {
    let cancelled = false;
    const cacheKey = book.title.trim().toLowerCase();
    const cached = bookAboutLookupCache.get(cacheKey);

    if (cached) {
      setAbout(cached);
      return () => { cancelled = true; };
    }

    // Start with the best local description while the online lookup runs.
    setAbout(getBookAbout(book));
    const query = encodeURIComponent(`intitle:"${book.title}"`);

    fetch(`https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=10&printType=books`)
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (cancelled) return;
        const items = Array.isArray(data?.items) ? data.items : [];
        const match = items.find((item: any) =>
          hasMatchingBookTitle(book.title, String(item?.volumeInfo?.title || ''))
          && typeof item?.volumeInfo?.description === 'string'
          && item.volumeInfo.description.trim().length > 40
        );
        const description = typeof match?.volumeInfo?.description === 'string'
          ? match.volumeInfo.description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
          : '';

        if (description) {
          bookAboutLookupCache.set(cacheKey, description);
          setAbout(description);
        } else {
          bookAboutLookupCache.set(cacheKey, null);
          // Retain the local title/category-based introduction if no verified
          // matching description is available from Google Books.
          setAbout(getBookAbout(book));
        }
      })
      .catch(() => {
        if (!cancelled) setAbout(getBookAbout(book));
      });

    return () => { cancelled = true; };
  }, [book.id, book.title, book.author, book.category, book.description]);

  return <p style={{ lineHeight: 1.75, whiteSpace: 'pre-line' }}>{about}</p>;
}

function App() {

  // Responsive mobile-library layout: compact header, swipeable catalog cards,
  // and a fixed bottom navigation similar to the supplied reference image.
  useEffect(() => {
    const styleId = 'libtrack-mobile-library-style';
    const existingStyle = document.getElementById(styleId) as HTMLStyleElement | null;
    const style = existingStyle || document.createElement('style');
    style.id = styleId;
    style.textContent = `
      /* LibTrack-branded single-form dialogs */
      ion-alert.libtrack-entry-form {
        --width: min(560px, calc(100vw - 28px));
        --max-width: 560px;
        --backdrop-opacity: .48;
        --background: #ffffff;
        --ion-text-color: #203047;
      }
      ion-alert.libtrack-entry-form .alert-wrapper {
        width: 100%; max-width: 560px; border-radius: 22px;
        overflow: hidden; box-shadow: 0 24px 70px rgba(18, 39, 63, .24);
        border: 1px solid #e3e9ef;
      }
      ion-alert.libtrack-entry-form .alert-head {
        padding: 23px 24px 10px;
        background: linear-gradient(110deg, #17283f 0%, #24445a 72%, #315a61 100%);
        border-bottom: 4px solid #e7c15b;
      }
      ion-alert.libtrack-entry-form .alert-title { color: #fff; font-size: 21px; font-weight: 800; letter-spacing: -.02em; }
      ion-alert.libtrack-entry-form .alert-sub-title { color: #dbe5ec; }
      ion-alert.libtrack-entry-form .alert-message { padding: 12px 24px 4px; color: #64748b; font-size: 13px; line-height: 1.5; }
      ion-alert.libtrack-entry-form .alert-input-group { padding: 8px 24px 14px; }
      ion-alert.libtrack-entry-form .alert-input-wrapper { display: block; margin: 0 0 13px; }
      ion-alert.libtrack-entry-form .alert-input { min-height: 44px; padding: 10px 12px; border: 1px solid #d7e0e8; border-radius: 10px; background: #f8fafc; color: #203047; font-size: 14px; }
      ion-alert.libtrack-entry-form .alert-input:focus { border-color: #54775b; box-shadow: 0 0 0 3px rgba(84,119,91,.13); }
      ion-alert.libtrack-entry-form .alert-button-group { padding: 12px 20px 20px; gap: 10px; }
      ion-alert.libtrack-entry-form .alert-button { min-height: 42px; border-radius: 11px; font-weight: 750; text-transform: none; letter-spacing: 0; }
      ion-alert.libtrack-entry-form .alert-button-role-cancel { border: 1px solid #d7e0e8; color: #475569; }
      ion-alert.libtrack-entry-form .alert-button:not(.alert-button-role-cancel) { background: #54775b; color: #fff; }
      @media (max-width: 600px) {
        ion-alert.libtrack-entry-form .alert-wrapper { border-radius: 20px 20px 0 0; }
        ion-alert.libtrack-entry-form .alert-head { padding: 20px 20px 10px; }
        ion-alert.libtrack-entry-form .alert-input-group { padding-left: 20px; padding-right: 20px; }
      }
      /* Unified LibTrack popup design: navy, gold, white, responsive */
      ion-alert.libtrack-alert {
        --width: min(440px, calc(100vw - 32px));
        --max-width: 440px;
        --backdrop-opacity: .56;
        --background: #ffffff;
        --ion-text-color: #203047;
      }
      ion-alert.libtrack-alert .alert-wrapper {
        width: 100%; max-width: 440px; border-radius: 22px;
        overflow: hidden; background: #fff;
        border: 1px solid rgba(226, 232, 240, .95);
        box-shadow: 0 26px 80px rgba(15, 32, 52, .28);
      }
      ion-alert.libtrack-alert .alert-head {
        padding: 23px 24px 17px;
        background: linear-gradient(118deg, #14263d 0%, #203d55 68%, #315a61 100%);
        border-bottom: 4px solid #e8c15a;
      }
      ion-alert.libtrack-alert .alert-title {
        color: #fff; font-size: 21px; line-height: 1.25;
        font-weight: 800; letter-spacing: -.025em;
      }
      ion-alert.libtrack-alert .alert-sub-title {
        margin-top: 5px; color: #dbe5ed; font-size: 13px;
      }
      ion-alert.libtrack-alert .alert-message {
        padding: 19px 24px 8px; color: #526174;
        font-size: 14px; line-height: 1.65; text-align: left;
      }
      ion-alert.libtrack-alert .alert-input-group {
        padding: 13px 24px 8px;
      }
      ion-alert.libtrack-alert .alert-input-wrapper {
        display: block; margin: 0 0 12px;
      }
      ion-alert.libtrack-alert .alert-input {
        min-height: 46px; padding: 11px 13px;
        border: 1px solid #d8e1e9; border-radius: 12px;
        background: #f8fafc; color: #203047; font-size: 14px;
      }
      ion-alert.libtrack-alert .alert-input:focus {
        border-color: #c39b3e; box-shadow: 0 0 0 3px rgba(232, 193, 90, .2);
      }
      ion-alert.libtrack-alert .alert-button-group {
        display: flex; gap: 10px; padding: 17px 22px 22px;
      }
      ion-alert.libtrack-alert .alert-button {
        flex: 1; min-height: 44px; margin: 0; padding: 0 15px;
        border-radius: 12px; font-size: 14px; font-weight: 750;
        text-transform: none; letter-spacing: 0;
      }
      ion-alert.libtrack-alert .alert-button.libtrack-dialog-cancel,
      ion-alert.libtrack-alert .alert-button-role-cancel {
        color: #435268; background: #f1f5f9;
        border: 1px solid #dbe3eb;
      }
      ion-alert.libtrack-alert .alert-button.libtrack-dialog-confirm,
      ion-alert.libtrack-alert .alert-button:not(.libtrack-dialog-cancel):not(.alert-button-role-cancel) {
        color: #17283f; background: linear-gradient(135deg, #f2d477, #dfb64d);
        box-shadow: 0 5px 13px rgba(191, 148, 49, .2);
      }
      ion-alert.libtrack-alert .alert-button:active { transform: translateY(1px); }
      ion-alert.libtrack-alert .alert-radio-group,
      ion-alert.libtrack-alert .alert-checkbox-group { border-color: #e6ebf0; }
      ion-alert.libtrack-alert .alert-radio-label,
      ion-alert.libtrack-alert .alert-checkbox-label { color: #334155; }
      ion-alert.libtrack-alert .alert-radio-icon,
      ion-alert.libtrack-alert .alert-checkbox-icon { border-color: #9aa8b7; }
      ion-alert.libtrack-confirm-alert .alert-message { text-align: center; padding-top: 21px; }
      ion-alert.libtrack-success-alert .alert-message {
        text-align: center; padding: 22px 26px 12px;
        color: #526174; font-size: 14px; line-height: 1.65;
      }
      ion-alert.libtrack-success-alert .alert-head { text-align: center; }
      ion-alert.libtrack-success-alert .alert-button-group { justify-content: center; }
      ion-alert.libtrack-success-alert .alert-button { max-width: 180px; }
      @media (max-width: 600px) {
        ion-alert.libtrack-alert { --width: calc(100vw - 28px); }
        ion-alert.libtrack-alert .alert-wrapper { border-radius: 20px; }
        ion-alert.libtrack-alert .alert-head { padding: 21px 20px 15px; }
        ion-alert.libtrack-alert .alert-title { font-size: 19px; }
        ion-alert.libtrack-alert .alert-message { padding: 17px 20px 7px; }
        ion-alert.libtrack-alert .alert-input-group { padding-left: 20px; padding-right: 20px; }
        ion-alert.libtrack-alert .alert-button-group { padding: 14px 18px 19px; }
      }
      .libtrack-mobile-bottom-nav { display: none; }
      /* Student header uses the same compact branded arrangement on laptop and phone. */
      @media (min-width: 701px) {
        .student-layout .app-topbar {
          display: grid !important;
          grid-template-columns: minmax(0, 1fr) auto !important;
          align-items: center !important;
          gap: 16px !important;
          min-height: 76px !important;
          padding: 10px 22px !important;
        }
        .student-layout .topbar-brand { min-width: 0 !important; display: flex !important; align-items: center !important; gap: 12px !important; }
        .student-layout .topbar-brand-copy { display: flex !important; flex-direction: column !important; min-width: 0 !important; }
        .student-layout .topbar-brand-copy strong { color: #fff !important; font-size: 19px !important; line-height: 1.15 !important; }
        .student-layout .topbar-brand-copy small { color: rgba(255,255,255,.82) !important; font-size: 10px !important; line-height: 1.35 !important; }
        .student-layout .topbar-school-logo { display: none !important; }
        .student-layout .topbar-action-stack { display: flex !important; flex-direction: row !important; align-items: center !important; justify-content: flex-end !important; gap: 12px !important; }
        .student-layout .topbar-actions { display: flex !important; align-items: center !important; gap: 12px !important; }
        .student-layout .topbar-logout { display: none !important; }
        .student-layout .topbar-account { gap: 9px !important; }
      }

      /* Desktop/laptop header: keep the brand, page title, and account aligned. */
      .app-topbar {
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        gap: 24px !important;
        width: 100% !important;
        min-height: 78px !important;
        box-sizing: border-box !important;
        padding: 12px 24px !important;
        margin: 0 !important;
        background: linear-gradient(110deg, #17283f 0%, #24445a 68%, #315a61 100%) !important;
        border-bottom: 4px solid #e7c15b !important;
        color: #ffffff !important;
        box-shadow: 0 5px 18px rgba(17,36,57,.12) !important;
      }
      /* Desktop/laptop: keep account actions on one horizontal row. */
      .topbar-action-stack {
        display: flex !important;
        flex: 0 0 auto !important;
        flex-direction: row !important;
        align-items: center !important;
        justify-content: flex-end !important;
        gap: 12px !important;
        min-width: 0 !important;
      }
      .topbar-logout {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        min-height: 38px;
        padding: 8px 13px;
        border: 1px solid rgba(255,255,255,.5);
        border-radius: 11px;
        background: rgba(255,255,255,.12);
        color: #fff;
        font: 700 13px/1.2 "DM Sans", sans-serif;
        white-space: nowrap;
        cursor: pointer;
      }
      .topbar-logout:hover { background: rgba(255,255,255,.2); }

      /* White open-book logo for the left sidebar only. */
      .app-sidebar .brand-mark {
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        box-sizing: border-box !important;
        flex: 0 0 64px !important;
        width: 64px !important;
        height: 64px !important;
        padding: 4px !important;
        border: 3px solid #f8c94e !important;
        border-radius: 18px !important;
        background: #ffffff !important;
        color: #173b60 !important;
        overflow: hidden !important;
        box-shadow: none !important;
      }
      .app-sidebar .brand-mark svg {
        display: block !important;
        width: 100% !important;
        height: 100% !important;
      }

      .topbar-brand-mark {
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        flex: 0 0 42px !important;
        width: 42px !important;
        height: 42px !important;
        border-radius: 13px !important;
        background: #f4d06f !important;
        color: #17283f !important;
        font-size: 22px !important;
        line-height: 1 !important;
        box-shadow: inset 0 0 0 1px rgba(255,255,255,.4) !important;
      }
      .topbar-heading {
        min-width: 0 !important;
        flex: 1 1 auto !important;
        text-align: left !important;
        display: flex !important;
        flex-direction: column !important;
        align-items: flex-start !important;
        justify-content: center !important;
        gap: 5px !important;
      }
      .app-topbar .eyebrow {
        display: block !important;
        margin: 0 !important;
        color: #f4d06f !important;
        font-size: 11px !important;
        line-height: 1.3 !important;
        font-weight: 800 !important;
        letter-spacing: .15em !important;
      }
      .app-topbar h1 {
        color: #ffffff !important;
        font-size: 24px !important;
        line-height: 1.15 !important;
        font-weight: 650 !important;
        margin: 0 !important;
      }
      .topbar-account {
        border: 0 !important;
        padding: 0 !important;
        background: transparent !important;
        font: inherit !important;
        cursor: pointer !important;
        display: flex !important;
        align-items: center !important;
        justify-content: flex-end !important;
        gap: 10px !important;
        flex: 0 0 auto !important;
        min-width: 0 !important;
        margin: 0 !important;
        color: #ffffff !important;
        font-size: 14px !important;
        white-space: nowrap !important;
      }
      .topbar-account .user-dot {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        flex: 0 0 36px !important;
        width: 36px !important;
        height: 36px !important;
        border-radius: 50% !important;
        background: #e5eee8 !important;
        color: #274b3a !important;
        border: 2px solid rgba(255,255,255,.8) !important;
        font-size: 14px !important;
        font-weight: 800 !important;
      }
      .topbar-account ion-badge {
        margin-left: 2px !important;
        font-size: 11px !important;
        font-weight: 800 !important;
      }
      /* Desktop book-details cover: larger portrait size; mobile sizing is overridden below. */
      .book-cover-detail-frame {
        display: block !important;
        width: 280px !important;
        height: 390px !important;
        min-width: 280px !important;
        min-height: 390px !important;
        max-width: calc(100vw - 96px) !important;
        margin: 4px auto 24px !important;
        padding: 0 !important;
        box-sizing: border-box !important;
        overflow: hidden !important;
        border-radius: 14px !important;
        background: #f7f1e3 !important;
      }
      .book-cover.book-cover-detail {
        flex: 0 0 100% !important;
        width: 100% !important;
        min-width: 0 !important;
        height: 100% !important;
        min-height: 0 !important;
        align-self: stretch !important;
        box-sizing: border-box !important;
        border-radius: inherit !important;
        margin: 0 !important;
      }
      .saved-book-cover {
        position: relative !important;
        display: block !important;
        width: 100% !important;
        height: 100% !important;
        min-width: 0 !important;
        min-height: 0 !important;
        max-width: 100% !important;
        max-height: 100% !important;
        flex: 0 0 100% !important;
        align-self: stretch !important;
        margin: 0 !important;
        border-radius: inherit !important;
        box-sizing: border-box !important;
        overflow: hidden !important;
      }
      .saved-book-cover img {
        position: absolute !important;
        inset: 0 !important;
        width: 100% !important;
        height: 100% !important;
        max-width: 100% !important;
        object-fit: contain !important;
        object-position: center !important;
        padding: 2px !important;
        margin: 0 !important;
      }
      .book-cover-detail img {
        position: absolute !important;
        inset: 0 !important;
        display: block !important;
        width: 100% !important;
        height: 100% !important;
        max-width: none !important;
        object-fit: contain !important;
        object-position: center !important;
        padding: 8px !important;
        margin: 0 !important;
      }


      /* Admin welcome hero: larger, more polished layered-book illustration. */
      .welcome-banner.admin-banner {
        position: relative !important;
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        gap: 28px !important;
        width: 100% !important;
        min-height: 218px !important;
        padding: 24px clamp(28px, 5vw, 64px) !important;
        box-sizing: border-box !important;
        overflow: hidden !important;
        border-radius: 0 0 24px 24px !important;
        background:
          radial-gradient(circle at 82% 48%, rgba(104,151,166,.2) 0 17%, transparent 17.2%),
          linear-gradient(112deg, #10283f 0%, #173b56 58%, #28566a 100%) !important;
        box-shadow: 0 18px 38px rgba(13,35,56,.16) !important;
      }
      .admin-banner .welcome-copy {
        position: relative !important;
        z-index: 3 !important;
        flex: 1 1 58% !important;
        max-width: 760px !important;
      }
      .admin-banner .gold-kicker {
        display: inline-block !important;
        margin-bottom: 18px !important;
        color: #f2c65b !important;
        font-size: 13px !important;
        font-weight: 850 !important;
        letter-spacing: .17em !important;
      }
      .admin-banner .welcome-copy h2 {
        margin: 0 0 14px !important;
        color: #fff !important;
        font-size: clamp(32px, 3vw, 42px) !important;
        line-height: 1.12 !important;
        letter-spacing: -.035em !important;
      }
      .admin-banner .welcome-copy h2 em { color: #fff !important; font-style: normal !important; }
      .admin-banner .welcome-copy p {
        max-width: 650px !important;
        margin: 0 !important;
        color: #c7d5e1 !important;
        font-size: clamp(15px, 1.25vw, 18px) !important;
        line-height: 1.65 !important;
      }
      .admin-banner .banner-art {
        position: relative !important;
        flex: 0 0 clamp(220px, 25vw, 300px) !important;
        width: clamp(220px, 25vw, 300px) !important;
        height: 194px !important;
        margin: 0 !important;
        transform: none !important;
        transform-origin: center !important;
      }
      .admin-banner .art-circle {
        position: absolute !important;
        width: 190px !important; height: 190px !important;
        left: 50% !important; top: 50% !important;
        transform: translate(-50%,-50%) !important;
        border-radius: 50% !important;
        background: linear-gradient(145deg, rgba(255,255,255,.055), rgba(255,255,255,.015)) !important;
        border: 1px solid rgba(220,235,245,.12) !important;
        box-shadow: inset 0 0 45px rgba(255,255,255,.025) !important;
      }
      .admin-banner .art-book {
        position: absolute !important;
        bottom: 18px !important;
        width: 70px !important; height: 150px !important;
        border: 1px solid rgba(15,32,45,.16) !important;
        border-radius: 5px 10px 10px 5px !important;
        box-shadow: 8px 11px 17px rgba(3,16,29,.28), inset 7px 0 0 rgba(20,35,48,.17), inset -3px 0 0 rgba(255,255,255,.22) !important;
        background-clip: padding-box !important;
        transform-origin: bottom center !important;
      }
      .admin-banner .art-book::before {
        content: "" !important;
        position: absolute !important;
        left: 8px !important; right: 7px !important; top: 8px !important; bottom: 8px !important;
        border: 1px solid rgba(255,255,255,.42) !important;
        border-left: 2px solid rgba(255,255,255,.55) !important;
        border-radius: 2px 6px 6px 2px !important;
        box-shadow: inset 2px 0 0 rgba(255,255,255,.16), inset -2px 0 0 rgba(0,0,0,.07) !important;
      }
      .admin-banner .art-book::after {
        content: "" !important;
        position: absolute !important;
        left: 17px !important; right: 13px !important; top: 29px !important;
        height: 2px !important; border-radius: 5px !important;
        background: rgba(255,255,255,.55) !important;
        box-shadow: 0 6px 0 rgba(255,255,255,.3), 0 12px 0 rgba(255,255,255,.22), 0 34px 0 rgba(255,255,255,.18) !important;
      }
      .admin-banner .art-book-a {
        left: 38px !important; bottom: 12px !important; background: linear-gradient(100deg,#b98532 0 10%,#f1cd76 13%,#e3b957 100%) !important;
        transform: rotate(-12deg) !important; z-index: 1 !important;
      }
      .admin-banner .art-book-b {
        left: 94px !important; bottom: 18px !important; height: 166px !important; width: 76px !important;
        background: linear-gradient(100deg,#b9ad9a 0 9%,#fff9ed 13%,#eee3d1 100%) !important;
        transform: rotate(5deg) !important; z-index: 2 !important;
      }
      .admin-banner .art-book-c {
        left: 151px !important; bottom: 12px !important;
        background: linear-gradient(100deg,#244f55 0 10%,#4c8584 14%,#2d666d 100%) !important;
        transform: rotate(13deg) !important; z-index: 3 !important;
      }
      .admin-banner .art-plant {
        position: absolute !important; right: 0 !important; top: 8px !important;
        color: #d6d99a !important; font-size: 64px !important; line-height: 1 !important;
        transform: rotate(12deg) !important; text-shadow: 0 8px 18px rgba(0,0,0,.12) !important;
      }

      @media (max-width: 700px) {
        .libtrack-app-content { --padding-start: 0; --padding-end: 0; }
        .app-layout { display: block !important; min-height: 100dvh; }
        .app-sidebar { display: none !important; }
        .app-main { width: 100% !important; min-width: 0 !important; padding: 0 !important; margin: 0 !important; }
        .app-topbar { position: sticky !important; top: 0 !important; z-index: 1000 !important; display: grid !important; grid-template-columns: minmax(0, 1fr) auto !important; grid-template-rows: auto !important; align-items: start !important; column-gap: 10px !important; row-gap: 0 !important; padding: calc(env(safe-area-inset-top) + 8px) 18px 12px !important; min-height: 0 !important; box-sizing: border-box; background: linear-gradient(115deg, #17283f 0%, #24445a 65%, #315a61 100%); border-bottom: 3px solid #e7c15b; color: #fff; box-shadow: 0 5px 18px rgba(17,36,57,.18); }
        .topbar-brand { grid-column: 1 !important; grid-row: 1 !important; min-width: 0 !important; }
        .topbar-brand-mark { width: 36px; height: 36px; min-width: 36px; display: flex; align-items: center; justify-content: center; justify-self: start; border-radius: 10px; background: #f4d06f; color: #17283f; font-size: 20px; line-height: 1; box-shadow: inset 0 0 0 1px rgba(255,255,255,.38); }
        .topbar-heading { position: absolute !important; left: 18px !important; bottom: 9px !important; grid-column: auto !important; grid-row: auto !important; min-width: 0 !important; width: auto !important; max-width: calc(100% - 150px) !important; flex: initial !important; text-align: left !important; align-self: auto !important; padding: 0 !important; margin: 0 !important; }
        .topbar-heading h1 { font-size: 20px !important; margin: 0 !important; line-height: 1.15 !important; }
        .topbar-action-stack { display: contents !important; }
        .topbar-actions { display: flex !important; align-items: center !important; justify-content: flex-end !important; gap: 7px !important; }
        .topbar-logout { position: absolute !important; right: 18px !important; bottom: 7px !important; grid-column: auto !important; grid-row: auto !important; justify-self: auto !important; align-self: auto !important; display: inline-flex !important; align-items: center !important; justify-content: center !important; gap: 6px !important; min-height: 32px !important; padding: 6px 10px !important; border: 1px solid rgba(255,255,255,.65) !important; border-radius: 12px !important; background: linear-gradient(180deg,#fff 0%,#edf2f7 100%) !important; color: #233b54 !important; box-shadow: 0 2px 6px rgba(7,24,43,.16) !important; font: 700 12px/1.2 "DM Sans",sans-serif !important; white-space: nowrap !important; }
        .app-topbar .eyebrow { display: block; color: #f4d06f !important; font-size: 7px !important; line-height: 1.2; font-weight: 800; letter-spacing: .08em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .app-topbar h1 { color: #fff !important; font-size: 17px !important; line-height: 1.15; margin: 1px 0 0 !important; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .topbar-account { margin-left: 0; gap: 0; font-size: 0 !important; width: 36px; height: 36px; justify-self: end; flex: initial; }
        .topbar-account .user-dot { width: 34px; height: 34px; flex: 0 0 34px; box-sizing: border-box; border: 2px solid rgba(255,255,255,.8); border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: #e5eee8; color: #274b3a; font-size: 14px; font-weight: 800; box-shadow: 0 0 0 2px rgba(255,255,255,.12); }
        .topbar-account ion-badge { display: none; }
        .app-page { padding: 16px 14px calc(130px + env(safe-area-inset-bottom)) !important; margin: 0 !important; width: 100%; box-sizing: border-box; }
        .welcome-banner { border-radius: 18px !important; padding: 22px 18px !important; min-height: auto !important; }
        .welcome-banner h2 { font-size: 27px !important; line-height: 1.15; }
        .welcome-banner p { font-size: 13px !important; }
        .banner-art { transform: scale(.75); transform-origin: right center; margin-left: -28px; }

        .welcome-banner.admin-banner {
          min-height: 190px !important;
          padding: 20px 18px !important;
          gap: 6px !important;
          border-radius: 18px !important;
        }
        .admin-banner .welcome-copy { flex: 1 1 62% !important; max-width: none !important; }
        .admin-banner .gold-kicker { font-size: 9px !important; letter-spacing: .12em !important; margin-bottom: 13px !important; }
        .admin-banner .welcome-copy h2 { font-size: clamp(25px, 7vw, 31px) !important; margin-bottom: 10px !important; }
        .admin-banner .welcome-copy p { font-size: 12px !important; line-height: 1.5 !important; }
        .admin-banner .banner-art {
          flex: 0 0 112px !important; width: 112px !important; height: 138px !important;
          margin: 0 -8px 0 -12px !important; transform: none !important;
        }
        .admin-banner .art-circle { width: 116px !important; height: 116px !important; }
        .admin-banner .art-book { width: 34px !important; height: 88px !important; bottom: 9px !important; border-radius: 3px 6px 6px 3px !important; }
        .admin-banner .art-book::before { left: 4px !important; right: 3px !important; top: 5px !important; bottom: 5px !important; }
        .admin-banner .art-book::after { left: 9px !important; right: 6px !important; top: 18px !important; height: 1px !important; box-shadow: 0 5px 0 rgba(255,255,255,.28), 0 10px 0 rgba(255,255,255,.2), 0 26px 0 rgba(255,255,255,.15) !important; }
        .admin-banner .art-book-a { left: 17px !important; bottom: 8px !important; }
        .admin-banner .art-book-b { left: 43px !important; width: 36px !important; height: 98px !important; bottom: 13px !important; }
        .admin-banner .art-book-c { left: 69px !important; bottom: 8px !important; }
        .admin-banner .art-plant { right: 0 !important; top: 0 !important; font-size: 25px !important; }

        .stats-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; gap: 9px !important; }
        .stat-card { min-width: 0; padding: 12px !important; gap: 8px !important; }
        .stat-card span, .stat-card small { font-size: 10px !important; }
        .stat-card strong { font-size: 22px !important; }
        .section-heading { align-items: flex-start !important; gap: 10px !important; flex-wrap: wrap; }
        .section-heading h2, .quick-section h2 { font-size: 23px !important; }
        /* Mobile book cards are laid out horizontally: cover on the left, details/actions on the right. */
        .book-grid { display: flex !important; flex-direction: column !important; align-items: stretch !important; overflow: visible !important; gap: 12px !important; padding: 4px 0 24px !important; margin: 0 !important; scroll-snap-type: none !important; }
        .book-grid > .book-tile { flex: 0 0 auto !important; width: 100% !important; min-width: 0 !important; height: 224px !important; min-height: 224px !important; display: flex !important; flex-direction: row !important; align-items: stretch !important; box-sizing: border-box !important; scroll-snap-align: none !important; }
        .book-cover { flex: 0 0 112px !important; width: 112px !important; min-width: 112px !important; min-height: 0 !important; height: auto !important; align-self: stretch !important; box-sizing: border-box !important; border-radius: 12px !important; margin: 8px !important; }
        /* Saved Books uses a compact thumbnail and must not inherit catalog cover sizing. */
        .book-cover.saved-book-cover {
          position: relative !important;
          display: block !important;
          flex: 0 0 100% !important;
          width: 100% !important;
          min-width: 0 !important;
          max-width: 100% !important;
          height: 100% !important;
          min-height: 0 !important;
          max-height: 100% !important;
          align-self: stretch !important;
          margin: 0 !important;
          padding: 0 !important;
          overflow: hidden !important;
          box-sizing: border-box !important;
          border-radius: inherit !important;
        }
        .book-cover.saved-book-cover img {
          position: absolute !important;
          inset: 0 !important;
          display: block !important;
          width: 100% !important;
          height: 100% !important;
          min-width: 0 !important;
          max-width: 100% !important;
          object-fit: contain !important;
          object-position: center center !important;
          transform: none !important;
          padding: 2px !important;
          margin: 0 !important;
        }
        /* The detail-modal cover must not inherit the 112px catalog-card sizing. */
        .book-cover.book-cover-detail {
          flex: 0 0 100% !important;
          width: 100% !important;
          min-width: 0 !important;
          height: 100% !important;
          min-height: 0 !important;
          align-self: stretch !important;
          box-sizing: border-box !important;
          border-radius: inherit !important;
          margin: 0 !important;
        }
        .book-cover-detail-frame {
          display: block !important;
          width: 180px !important;
          height: 250px !important;
          min-width: 180px !important;
          min-height: 250px !important;
          max-width: calc(100vw - 96px) !important;
          margin: 4px auto 24px !important;
          padding: 0 !important;
          box-sizing: border-box !important;
          overflow: hidden !important;
          border-radius: 14px !important;
          background: #f7f1e3 !important;
        }
        .book-cover-detail img {
          position: absolute !important;
          inset: 0 !important;
          display: block !important;
          width: 100% !important;
          height: 100% !important;
          max-width: none !important;
          object-fit: contain !important;
          object-position: center !important;
          padding: 8px !important;
          margin: 0 !important;
        }
        .book-tile { border-radius: 14px !important; overflow: hidden !important; }
        .book-tile .cover-title { font-size: 13px !important; line-height: 1.2 !important; }
        .book-tile .book-info { display: flex !important; flex: 1 1 0 !important; flex-direction: column !important; min-width: 0 !important; min-height: 0 !important; box-sizing: border-box !important; padding: 10px 10px 10px 2px !important; overflow: hidden !important; }
        .book-tile .book-category { display: -webkit-box !important; -webkit-box-orient: vertical !important; -webkit-line-clamp: 1 !important; overflow: hidden !important; min-height: 18px !important; max-height: 18px !important; line-height: 18px !important; font-size: 10px !important; margin: 0 0 4px !important; }
        .book-tile .book-info h3 { display: -webkit-box !important; -webkit-box-orient: vertical !important; -webkit-line-clamp: 2 !important; overflow: hidden !important; min-height: 38px !important; max-height: 38px !important; line-height: 19px !important; font-size: 14px !important; margin: 2px 0 4px !important; }
        .book-tile .book-info > p:not(.book-call-number) { display: -webkit-box !important; -webkit-box-orient: vertical !important; -webkit-line-clamp: 1 !important; overflow: hidden !important; min-height: 17px !important; max-height: 17px !important; line-height: 17px !important; font-size: 11px !important; margin: 0 0 4px !important; }
        .book-tile .book-call-number { min-height: 17px !important; max-height: 17px !important; overflow: hidden !important; line-height: 17px !important; font-size: 10px !important; margin: 0 0 4px !important; }
        .book-tile .book-meta { margin-top: auto !important; min-height: 34px !important; display: flex !important; flex-direction: column !important; align-items: flex-start !important; justify-content: flex-end !important; gap: 2px !important; font-size: 10px !important; }
        .book-tile .book-meta ion-badge { font-size: 10px !important; }
        .book-tile .book-info > button:last-child { margin-top: 6px !important; min-height: 34px !important; height: 34px !important; flex: 0 0 34px !important; width: 100% !important; font-size: 12px !important; padding: 0 8px !important; }
        .catalog-section, .quick-section { min-width: 0; }
        .catalog-section input, .catalog-section ion-searchbar { max-width: 100%; }
        .admin-table-wrap { max-width: 100%; width: 100%; overflow: visible !important; }
        /* Student borrowing history becomes readable stacked records on phones. */
        .app-main:has(.admin-borrowing-section) > .libtrack-topic-header { margin-bottom: 6px !important; }
        .admin-borrowing-section { padding-top: 0 !important; margin-top: 0 !important; }
        .admin-borrowing-section > .section-heading { margin-top: 0 !important; padding-top: 0 !important; }
        .admin-borrowing-section .section-heading { margin-bottom: 16px !important; }
        .admin-borrowing-section .admin-table-wrap { overflow: visible !important; border: 0 !important; }
        .admin-borrowing-section .admin-book-table,
        .admin-borrowing-section .admin-book-table tbody { display: block !important; width: 100% !important; min-width: 0 !important; }
        .admin-borrowing-section .admin-book-table thead { display: none !important; }
        .admin-borrowing-section .admin-book-table tbody tr {
          display: grid !important;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) !important;
          gap: 12px 14px !important;
          width: 100% !important;
          box-sizing: border-box !important;
          padding: 16px !important;
          margin: 0 0 12px !important;
          border: 1px solid #e1e6ec !important;
          border-radius: 16px !important;
          background: #ffffff !important;
          box-shadow: 0 4px 14px rgba(23,40,63,.045) !important;
        }
        .admin-borrowing-section .admin-book-table tbody td {
          display: flex !important;
          flex-direction: column !important;
          align-items: flex-start !important;
          gap: 5px !important;
          min-width: 0 !important;
          width: auto !important;
          padding: 0 !important;
          border: 0 !important;
          white-space: normal !important;
          overflow-wrap: anywhere !important;
          word-break: normal !important;
          font-size: 11px !important;
          line-height: 1.35 !important;
          color: #667085 !important;
          text-align: left !important;
        }
        .admin-borrowing-section .admin-book-table tbody td::before {
          content: attr(data-label);
          display: block !important;
          color: #8a929e !important;
          font-size: 10px !important;
          line-height: 1.3 !important;
          font-weight: 800 !important;
          letter-spacing: .055em !important;
          text-transform: uppercase !important;
        }
        .admin-borrowing-section .admin-book-table tbody td:first-child { grid-column: 1 / -1 !important; padding-bottom: 10px !important; border-bottom: 1px solid #edf0f3 !important; }
        .admin-borrowing-section .admin-book-table tbody td:first-child strong { font-size: 15px !important; line-height: 1.35 !important; color: #203047 !important; overflow-wrap: anywhere !important; }
        .admin-borrowing-section .admin-book-table tbody td:first-child small { font-size: 11px !important; color: #8a929e !important; }
        .admin-borrowing-section .admin-book-table tbody td:nth-child(3) strong { color: #203047 !important; font-size: 13px !important; }
        .admin-borrowing-section .admin-book-table tbody td:nth-child(5) { justify-content: flex-start !important; }
        .admin-borrowing-section .admin-book-table tbody td:nth-child(5) ion-badge { max-width: 100%; white-space: normal; }
        .dashboard-footer { display: none !important; }
        .libtrack-mobile-bottom-nav { position: fixed; z-index: 1000; display: grid !important; grid-template-columns: repeat(5, minmax(0, 1fr)); left: 0; right: 0; bottom: 0; padding: 8px 8px calc(8px + env(safe-area-inset-bottom)); background: rgba(255,255,255,.97); border-top: 1px solid rgba(100,116,139,.2); box-shadow: 0 -5px 20px rgba(15,23,42,.06); backdrop-filter: blur(16px); }
        .libtrack-mobile-bottom-nav button { border: 0; background: transparent; color: #8b9290; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; min-width: 0; padding: 5px 1px; font: inherit; font-size: 9px; cursor: pointer; }
        .libtrack-mobile-bottom-nav button span:first-child { width: 31px; height: 29px; display: flex; align-items: center; justify-content: center; font-size: 22px; border-radius: 18px; }
        .libtrack-mobile-bottom-nav button.active { color: #54775b; font-weight: 700; }
        .libtrack-mobile-bottom-nav button.active span:first-child { background: #e6eee7; }
        .app-topbar .topbar-logout { display: none !important; }
        .book-about-modal { padding: 16px !important; align-items: flex-end !important; }
        .book-about-modal > section { border-radius: 22px 22px 0 0 !important; max-height: 86dvh !important; overflow-y: auto !important; }
      }
      /* Refined desktop dashboard footer */
      .dashboard-footer {
        display: flex !important;
        align-items: center !important;
        justify-content: flex-start !important;
        gap: 16px !important;
        width: 100% !important;
        min-height: 58px !important;
        margin: 22px 0 0 !important;
        padding: 12px 22px !important;
        position: relative !important;
        overflow: hidden !important;
        box-sizing: border-box !important;
        color: #eaf1f8 !important;
        background: linear-gradient(112deg, #14283f 0%, #203e56 58%, #28515a 100%) !important;
        border: 1px solid rgba(255,255,255,.12) !important;
        border-radius: 12px 12px 0 0 !important;
        box-shadow: 0 -5px 22px rgba(20,40,63,.08) !important;
      }
      .dashboard-footer::before {
        content: "" !important;
        position: absolute !important;
        top: 0 !important;
        left: 0 !important;
        right: 0 !important;
        height: 3px !important;
        background: linear-gradient(90deg, #d8a83e, #f6dda0, #d8a83e) !important;
      }
      .dashboard-footer::after {
        content: "" !important;
        position: absolute !important;
        width: 180px !important;
        height: 180px !important;
        right: -48px !important;
        bottom: -122px !important;
        border: 1px solid rgba(255,255,255,.10) !important;
        border-radius: 50% !important;
        box-shadow: 0 0 0 18px rgba(255,255,255,.025), 0 0 0 38px rgba(255,255,255,.02) !important;
        pointer-events: none !important;
      }
      .dashboard-footer > span {
        display: inline-flex !important;
        align-items: center !important;
        gap: 10px !important;
        min-width: 0 !important;
        position: relative !important;
        z-index: 1 !important;
        color: #c4d1df !important;
        font-size: 11px !important;
        letter-spacing: .01em !important;
        line-height: 1.5 !important;
      }
      .dashboard-footer > span strong {
        color: #fff !important;
        font-size: 13px !important;
        font-weight: 800 !important;
        letter-spacing: .025em !important;
      }
      @media (max-width: 700px) {
        .dashboard-footer { display: none !important; }
      }
      @media (min-width: 701px) and (max-width: 1050px) {
        .app-topbar { gap: 16px !important; padding-left: 22px !important; padding-right: 22px !important; }
        .topbar-brand-mark { flex-basis: 42px !important; width: 42px !important; height: 42px !important; font-size: 22px !important; }
        .app-topbar h1 { font-size: 24px !important; }
        .app-topbar .eyebrow { font-size: 9px !important; letter-spacing: .1em !important; }
        .topbar-account { gap: 8px !important; font-size: 13px !important; }
      }
      @media (max-width: 380px) {
        .app-topbar { grid-template-columns: 32px minmax(0, 1fr) 32px; column-gap: 8px; padding-left: 10px !important; padding-right: 10px !important; }
        .topbar-brand-mark { width: 32px; height: 32px; min-width: 32px; font-size: 18px; }
        .topbar-account, .topbar-account .user-dot { width: 32px; height: 32px; }
        .topbar-account .user-dot { flex-basis: 32px; font-size: 13px; }
        .app-topbar .eyebrow { font-size: 7px !important; letter-spacing: .045em; }
        .app-topbar h1 { font-size: 18px !important; }
      }
      .remember-me-option {
        display: grid;
        grid-template-columns: 18px 1fr;
        align-items: center;
        column-gap: 9px;
        row-gap: 2px;
        margin: 2px 0 8px;
        color: #173b60;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
      }
      .remember-me-option input {
        grid-row: 1 / span 2;
        width: 17px;
        height: 17px;
        margin: 0;
        accent-color: #173b60;
        cursor: pointer;
      }
      .remember-me-option small {
        color: #71839a;
        font-size: 12px;
        font-weight: 400;
      }
      /* Mobile Settings layout: single-column cards inspired by the supplied phone reference. */
      @media (max-width: 760px) {
        .settings-page {
          width: 100% !important;
          max-width: 100% !important;
          box-sizing: border-box !important;
          padding: 12px 14px calc(92px + env(safe-area-inset-bottom)) !important;
          margin: 0 auto !important;
        }
        .settings-shortcut-grid,
        .settings-shortcut-grid.admin-shortcuts {
          display: grid !important;
          grid-template-columns: minmax(0, 1fr) !important;
          gap: 10px !important;
          width: 100% !important;
        }
        .settings-shortcut-grid > .settings-shortcut {
          display: grid !important;
          grid-template-columns: 46px minmax(0, 1fr) 16px !important;
          align-items: center !important;
          column-gap: 11px !important;
          width: 100% !important;
          min-height: 88px !important;
          box-sizing: border-box !important;
          padding: 12px 13px !important;
          margin: 0 !important;
          border-radius: 20px !important;
          text-align: left !important;
        }
        .settings-shortcut-grid > .settings-shortcut .settings-shortcut-icon {
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          width: 46px !important;
          height: 46px !important;
          min-width: 46px !important;
          border-radius: 14px !important;
          font-size: 22px !important;
        }
        .settings-shortcut-grid > .settings-shortcut > span:nth-child(2) {
          display: flex !important;
          flex-direction: column !important;
          min-width: 0 !important;
          gap: 5px !important;
        }
        .settings-shortcut-grid > .settings-shortcut strong {
          display: block !important;
          font-size: 14px !important;
          line-height: 1.3 !important;
          overflow-wrap: anywhere !important;
        }
        .settings-shortcut-grid > .settings-shortcut small {
          display: block !important;
          font-size: 13px !important;
          line-height: 1.4 !important;
          white-space: normal !important;
          overflow-wrap: anywhere !important;
        }
        .settings-shortcut-grid > .settings-shortcut > b {
          justify-self: end !important;
          font-size: 21px !important;
        }
        .settings-section-title {
          margin-bottom: 16px !important;
        }
      }

      /* Final override: fit the five mobile navigation buttons evenly. */
      @media (max-width: 760px) {
        .app-topbar .topbar-logout { display: none !important; }
        .libtrack-mobile-bottom-nav {
          display: grid !important;
          grid-template-columns: repeat(5, minmax(0, 1fr)) !important;
          width: 100% !important;
          box-sizing: border-box !important;
        }
        .libtrack-mobile-bottom-nav > button {
          display: flex !important;
          min-width: 0 !important;
          width: 100% !important;
          visibility: visible !important;
          opacity: 1 !important;
          overflow: visible !important;
          padding-left: 0 !important;
          padding-right: 0 !important;
          font-size: 9px !important;
          white-space: nowrap !important;
        }
      }

      /* Final admin hero refinement: balanced typography and a clean framed edge. */
      .welcome-banner.admin-banner {
        min-height: 176px !important;
        padding: 22px clamp(22px, 3.4vw, 42px) !important;
        border: 1px solid rgba(218, 232, 242, .24) !important;
        border-radius: 22px !important;
        box-shadow: 0 10px 26px rgba(9, 31, 51, .13), inset 0 1px 0 rgba(255,255,255,.08) !important;
      }
      .admin-banner .gold-kicker {
        font-size: 11px !important;
        letter-spacing: .14em !important;
        margin-bottom: 12px !important;
      }
      .admin-banner .welcome-copy h2 {
        font-size: clamp(25px, 2.15vw, 32px) !important;
        line-height: 1.16 !important;
        letter-spacing: -.025em !important;
        margin: 0 0 9px !important;
      }
      .admin-banner .welcome-copy p {
        font-size: clamp(13px, 1vw, 15px) !important;
        line-height: 1.5 !important;
        max-width: 560px !important;
      }
      .admin-banner .banner-art {
        flex-basis: clamp(190px, 22vw, 250px) !important;
        width: clamp(190px, 22vw, 250px) !important;
        height: 166px !important;
      }
      .admin-banner .art-circle {
        width: 164px !important;
        height: 164px !important;
      }
      @media (max-width: 640px) {
        .welcome-banner.admin-banner {
          min-height: 142px !important;
          padding: 17px 14px !important;
          gap: 4px !important;
          border-radius: 16px !important;
        }
        .admin-banner .gold-kicker {
          font-size: 8px !important;
          letter-spacing: .1em !important;
          margin-bottom: 9px !important;
        }
        .admin-banner .welcome-copy h2 {
          font-size: clamp(21px, 6vw, 26px) !important;
          margin-bottom: 7px !important;
        }
        .admin-banner .welcome-copy p {
          font-size: 10px !important;
          line-height: 1.4 !important;
        }
        .admin-banner .banner-art {
          flex: 0 0 104px !important;
          width: 104px !important;
          height: 116px !important;
          margin: 0 -5px 0 -8px !important;
        }
        .admin-banner .art-circle {
          width: 102px !important;
          height: 102px !important;
        }
      }
    `;
    if (!existingStyle) document.head.appendChild(style);
  }, []);

  const [token, setToken] = useState(

    () => localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || '',

  );

  const [user, setUser] = useState<AuthUser | null>(null);

  const [userLoading, setUserLoading] = useState(false);

  const [isRegister, setIsRegister] = useState(false);

  const [registerType, setRegisterType] = useState<'student' | 'faculty'>('student');

  const [name, setName] = useState('');

  const [studentId, setStudentId] = useState('');

  const [course, setCourse] = useState('');

  const [year, setYear] = useState('');

  const [section, setSection] = useState('');

  const [email, setEmail] = useState('');

  const [username, setUsername] = useState('');

  const [signupPhoto, setSignupPhoto] = useState<File | null>(null);
  const [signupPhotoPreview, setSignupPhotoPreview] = useState('');
  const [profilePhotoSaving, setProfilePhotoSaving] = useState(false);
  const [profilePhotoPreview, setProfilePhotoPreview] = useState<{ url: string; name: string } | null>(null);

  const [password, setPassword] = useState('');

  // Remember Me is enabled by default; users can turn it off for this login.
  const [rememberMe, setRememberMe] = useState(true);

  const [confirmPassword, setConfirmPassword] = useState('');

  const [showPassword, setShowPassword] = useState(false);

  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const [currentAccountPassword, setCurrentAccountPassword] = useState('');
  const [newAccountPassword, setNewAccountPassword] = useState('');
  const [confirmAccountPassword, setConfirmAccountPassword] = useState('');
  const [showCurrentAccountPassword, setShowCurrentAccountPassword] = useState(false);
  const [showNewAccountPassword, setShowNewAccountPassword] = useState(false);
  const [showConfirmAccountPassword, setShowConfirmAccountPassword] = useState(false);
  const [changePasswordSaving, setChangePasswordSaving] = useState(false);
  const [changePasswordMessage, setChangePasswordMessage] = useState('');
  const [problemCategory, setProblemCategory] = useState('Account or profile');
  const [problemDescription, setProblemDescription] = useState('');
  const [problemReportMessage, setProblemReportMessage] = useState('');
  const [problemReportSubmitting, setProblemReportSubmitting] = useState(false);
  const [adminProblemReports, setAdminProblemReports] = useState<any[]>([]);
  const [adminProblemReportsLoading, setAdminProblemReportsLoading] = useState(false);
  const [adminProblemReportError, setAdminProblemReportError] = useState('');
  const [savedBookIds, setSavedBookIds] = useState<number[]>([]);
  const [preferences, setPreferences] = useState({ borrowingUpdates: true, libraryAnnouncements: true, dueDateReminders: true });

  const [page, setPage] = useState<Page>('home');
  useEffect(() => {
    if (!user?.id) {
      setSavedBookIds([]);
      return;
    }
    const savedKey = `libtrack_saved_books_${user.id}`;
    const preferenceKey = `libtrack_app_preferences_${user.id}`;
    try {
      const saved = JSON.parse(localStorage.getItem(savedKey) || '[]');
      setSavedBookIds(Array.isArray(saved) ? saved.filter((id) => Number.isFinite(Number(id))).map(Number) : []);
      const storedPreferences = JSON.parse(localStorage.getItem(preferenceKey) || '{}');
      setPreferences({
        borrowingUpdates: storedPreferences.borrowingUpdates !== false,
        libraryAnnouncements: storedPreferences.libraryAnnouncements !== false,
        dueDateReminders: storedPreferences.dueDateReminders !== false,
      });
    } catch {
      setSavedBookIds([]);
      setPreferences({ borrowingUpdates: true, libraryAnnouncements: true, dueDateReminders: true });
    }
  }, [user?.id]);

  function toggleSavedBook(bookId: number) {
    if (!user?.id) return;
    setSavedBookIds((current) => {
      const next = current.includes(bookId) ? current.filter((id) => id !== bookId) : [...current, bookId];
      localStorage.setItem(`libtrack_saved_books_${user.id}`, JSON.stringify(next));
      return next;
    });
  }

  function updateAppPreference(key: keyof typeof preferences, value: boolean) {
    if (!user?.id) return;
    setPreferences((current) => {
      const next = { ...current, [key]: value };
      localStorage.setItem(`libtrack_app_preferences_${user.id}`, JSON.stringify(next));
      return next;
    });
  }

  const pageHistoryRef = useRef<Page[]>([]);
  const appContentRef = useRef<any>(null);

  // Support the device/browser Back action using LibTrack's in-app page history.
  useEffect(() => {
    const handleDeviceBack = () => {
      const previousPage = pageHistoryRef.current.pop();
      if (previousPage) {
        setPage(previousPage);
        if (previousPage === 'research') {
          setResearchView('collections');
          setSelectedResearchCourse('');
          setSelectedResearchId(null);
          setResearchQuery('');
        }
      } else if (page !== 'home') {
        setPage('home');
      }
      setError('');
      setNotice('');
    };
    window.addEventListener('popstate', handleDeviceBack);
    return () => window.removeEventListener('popstate', handleDeviceBack);
  }, [page]);

  const [researchQuery, setResearchQuery] = useState('');

  const [selectedResearchId, setSelectedResearchId] = useState<number | null>(null);
  const [selectedResearchCourse, setSelectedResearchCourse] = useState<string>('');
  const [researchView, setResearchView] = useState<ResearchView>('collections');

  const [additionalCourses, setAdditionalCourses] = useState<string[]>([]);
  const [researchItems, setResearchItems] = useState<ResearchMaterial[]>([]);

  const [researchLoading, setResearchLoading] = useState(false);
  const [researchCollectionCovers, setResearchCollectionCovers] = useState<Record<string, string>>({});
  const [researchCollectionCoverUploading, setResearchCollectionCoverUploading] = useState<string | null>(null);
  const [ebookCollectionCovers, setEbookCollectionCovers] = useState<Record<string, string>>({});
  const [ebookCollectionCoverUploading, setEbookCollectionCoverUploading] = useState<string | null>(null);
  const ebookCollectionCoverInputRef = useRef<HTMLInputElement | null>(null);
  const ebookCollectionCoverTargetRef = useRef<string | null>(null);
  const newCourseCoverTargetRef = useRef<string | null>(null);
  const researchCollectionCoverInputRef = useRef<HTMLInputElement | null>(null);
  const researchCollectionCoverTargetRef = useRef<string | null>(null);

  const [ebooks, setEbooks] = useState<EBook[]>([]);
  const [ebooksLoading, setEbooksLoading] = useState(false);
  const [ebooksError, setEbooksError] = useState('');
  const [ebookQuery, setEbookQuery] = useState('');
  const [ebookUploadCourse, setEbookUploadCourse] = useState('BSIT');
  const [ebookUploadYear, setEbookUploadYear] = useState('1ST YEAR CICT');
  const [ebookUploadSemester, setEbookUploadSemester] = useState('1st sem 1st yr cict');
  const [ebookUploadSubject, setEbookUploadSubject] = useState('');
  const [showEbookUploadForm, setShowEbookUploadForm] = useState(false);
  const [selectedEbook, setSelectedEbook] = useState<EBook | null>(null);
  const [selectedEbookCourse, setSelectedEbookCourse] = useState<string | null>(null);
  const [selectedEbookYear, setSelectedEbookYear] = useState<string | null>(null);
  const [selectedEbookSemester, setSelectedEbookSemester] = useState<string | null>(null);
  const [selectedEbookSubject, setSelectedEbookSubject] = useState<string | null>(null);
  const ebookPdfInputRef = useRef<HTMLInputElement | null>(null);
  const ebookZipInputRef = useRef<HTMLInputElement | null>(null);
  const ebookCoverInputRef = useRef<HTMLInputElement | null>(null);
  const ebookCoverTargetRef = useRef<string | null>(null);
  const [ebookCoverUploadingId, setEbookCoverUploadingId] = useState<string | null>(null);
  const [ebookUploading, setEbookUploading] = useState(false);
  const [pdfUploadingResearchId, setPdfUploadingResearchId] = useState<number | null>(null);
  const researchPdfInputRef = useRef<HTMLInputElement | null>(null);
  const uploadTargetResearchIdRef = useRef<number | null>(null);

  // Keep the admin upload selectors aligned with the collection currently being browsed.
  // This prevents showing BSIT subjects while the folder browser is on BSBA/BSED.
  useEffect(() => {
    if (!selectedEbookCourse) return;
    const course = selectedEbookCourse;
    const year = selectedEbookYear || (course === 'BSIT' ? '1ST YEAR CICT' : `1ST YEAR ${course}`);
    const semesterLabel = selectedEbookSemester || (course === 'BSIT'
      ? `1st sem ${year.toLowerCase().replace(' year cict', ' yr cict')}`
      : '1st Semester');
    setEbookUploadCourse(course);
    setEbookUploadYear(year);
    setEbookUploadSemester(semesterLabel);
    setEbookUploadSubject('');
  }, [selectedEbookCourse, selectedEbookYear, selectedEbookSemester]);

  const [query, setQuery] = useState('');

  const [selectedCategory, setSelectedCategory] = useState('');

  const [accountQuery, setAccountQuery] = useState('');
  const [selectedAccountGroup, setSelectedAccountGroup] = useState('BSIT');

  const [deletingAccountId, setDeletingAccountId] = useState<number | null>(null);

  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [expandedStudentId, setExpandedStudentId] = useState<number | null>(null);
  const [accountEditDraft, setAccountEditDraft] = useState({ full_name: '', email: '', username: '', student_id: '', course: '', year: '', section: '', role: 'student', active: true });
  const [accountEditSaving, setAccountEditSaving] = useState(false);

  const [inventoryTab, setInventoryTab] = useState<'books' | 'research' | 'ebooks'>('books');
  const [inventoryQuery, setInventoryQuery] = useState('');
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryError, setInventoryError] = useState('');

  const [books, setBooks] = useState<Book[]>([]);
  const [mostBorrowedBooks, setMostBorrowedBooks] = useState<MostBorrowedBook[]>([]);
  const [mostBorrowingStudents, setMostBorrowingStudents] = useState<MostBorrowingStudent[]>([]);
  const [borrowingStats, setBorrowingStats] = useState<any>(null);
  const [borrowingStatsLoading, setBorrowingStatsLoading] = useState(false);
  const [borrowingStatsError, setBorrowingStatsError] = useState('');
  const [borrowingStatsSemester, setBorrowingStatsSemester] = useState<'all' | '1st' | '2nd'>('all');

  const [selectedBook, setSelectedBook] = useState<Book | null>(null);

  const [accounts, setAccounts] = useState<Account[]>([]);

  const [loginSessions, setLoginSessions] = useState<LoginSession[]>([]);

  const [borrowings, setBorrowings] = useState<Borrowing[]>([]);
  const dueReminderSignatureRef = useRef<string | null>(null);
  const [lostBookCases, setLostBookCases] = useState<LostBookCase[]>([]);
  const [lostCasesLoading, setLostCasesLoading] = useState(false);
  const [lostBookDialog, setLostBookDialog] = useState<{
    mode: 'report' | 'resolve'; record?: Borrowing; caseType?: 'lost' | 'damaged';
    item?: LostBookCase; resolution?: 'paid' | 'replaced';
  } | null>(null);
  const [receiptPreviewCase, setReceiptPreviewCase] = useState<LostBookCase | null>(null);
  const [receiptAttachmentUrl, setReceiptAttachmentUrl] = useState<string | null>(null);
  const [receiptAttachmentLoading, setReceiptAttachmentLoading] = useState(false);
  const [receiptReuploadLoading, setReceiptReuploadLoading] = useState(false);
  const [lostBookMarketValue, setLostBookMarketValue] = useState('0');
  const [lostBookAdditionalFine, setLostBookAdditionalFine] = useState('0');
  const [lostBookNote, setLostBookNote] = useState('');
  const [lostBookReceiptNumber, setLostBookReceiptNumber] = useState('');
  const [lostBookAmountPaid, setLostBookAmountPaid] = useState('');
  const [lostBookPaymentDate, setLostBookPaymentDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [lostBookPaymentMethod, setLostBookPaymentMethod] = useState('Cash');
  const [lostBookReplacementTitle, setLostBookReplacementTitle] = useState('');
  const [lostBookReplacementDate, setLostBookReplacementDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [lostBookReceivedBy, setLostBookReceivedBy] = useState('');
  const [lostBookReceiptFile, setLostBookReceiptFile] = useState<File | null>(null);



  const [borrowingsLoading, setBorrowingsLoading] = useState(false);

  const [borrowingsError, setBorrowingsError] = useState('');

  const [showDueNotifications, setShowDueNotifications] = useState(false);
  const [studentNotifications, setStudentNotifications] = useState<UserNotification[]>([]);
  const [selectedStudentNotification, setSelectedStudentNotification] = useState<UserNotification | null>(null);
  const [studentNotificationsLoading, setStudentNotificationsLoading] = useState(false);
  const seenStudentNotificationIdsRef = useRef<Set<number>>(new Set());
  const studentNotificationsInitializedRef = useRef(false);
  const studentNotificationPopupBusyRef = useRef(false);


  const [borrowRequestConfirmation, setBorrowRequestConfirmation] = useState<Book | null>(null);
  const [pickupConfirmation, setPickupConfirmation] = useState<Borrowing | null>(null);
  const [approvalDueDate, setApprovalDueDate] = useState(() => {
    const suggestedDate = new Date();
    suggestedDate.setDate(suggestedDate.getDate() + 7);
    return `${suggestedDate.getFullYear()}-${String(suggestedDate.getMonth() + 1).padStart(2, '0')}-${String(suggestedDate.getDate()).padStart(2, '0')}`;
  });

  const [returnConfirmation, setReturnConfirmation] = useState<Borrowing | null>(null);

  const [error, setError] = useState('');
  const [weekendNoticeEnabled, setWeekendNoticeEnabled] = useState(true);
  const [weekendNoticeTime, setWeekendNoticeTime] = useState('07:00');
  const [weekendNoticeMessage, setWeekendNoticeMessage] = useState('Book borrowing is unavailable on Saturdays and Sundays. Please visit the library during regular operating days (Monday-Friday).');
  const [weekendNoticeSaving, setWeekendNoticeSaving] = useState(false);
  const [weekendNoticeSaveMessage, setWeekendNoticeSaveMessage] = useState('');
  const [showAdminNoticePreview, setShowAdminNoticePreview] = useState(false);
  const [apiHealthStatus, setApiHealthStatus] = useState<'unknown' | 'checking' | 'online' | 'offline'>('unknown');
  const [apiHealthMessage, setApiHealthMessage] = useState('');
  const [showWeekendNoticePopup, setShowWeekendNoticePopup] = useState(false);
  const [librarySchedule, setLibrarySchedule] = useState<Record<string, { closed: boolean; open: string; close: string }>>({
    Monday: { closed: false, open: '12:00', close: '22:00' },
    Tuesday: { closed: false, open: '12:00', close: '22:00' },
    Wednesday: { closed: false, open: '12:00', close: '22:00' },
    Thursday: { closed: false, open: '12:00', close: '22:00' },
    Friday: { closed: false, open: '12:00', close: '22:00' },
    Saturday: { closed: true, open: '08:00', close: '12:00' },
    Sunday: { closed: true, open: '08:00', close: '12:00' },
  });
  const [borrowingSchedule, setBorrowingSchedule] = useState({
    enabled: true,
    days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    open_time: '08:00',
    close_time: '17:00',
    message: 'Book borrowing is currently unavailable. Please check the library borrowing schedule.',
  });
  const [borrowingScheduleSaving, setBorrowingScheduleSaving] = useState(false);
  const [borrowingScheduleMessage, setBorrowingScheduleMessage] = useState('');
  const [libraryScheduleSaving, setLibraryScheduleSaving] = useState(false);
  const [libraryScheduleMessage, setLibraryScheduleMessage] = useState('');
  const bookAvailabilitySnapshotRef = useRef<Map<number, number> | null>(null);


  const [notice, setNotice] = useState('');

  const [loading, setLoading] = useState(false);

  const [booksLoading, setBooksLoading] = useState(false);

  const [accountsLoading, setAccountsLoading] = useState(false);

  const [sessionsLoading, setSessionsLoading] = useState(false);

  const [savingBook, setSavingBook] = useState(false);

  const [accountsError, setAccountsError] = useState('');

  const [sessionsError, setSessionsError] = useState('');

  const normalizedUserRole = String(user?.role || '').trim().toLowerCase();
  const isAdmin = normalizedUserRole === 'admin';
  const isFaculty = normalizedUserRole === 'faculty';
  const isStudent = normalizedUserRole === 'student' || isFaculty;
  const isStudentAccount = normalizedUserRole === 'student';
  const accountRoleLabel = isAdmin ? 'ADMINISTRATOR' : isFaculty ? 'FACULTY' : 'STUDENT';

  // ---------------------------------------------------------

  // LOGIN AND REGISTER

  // ---------------------------------------------------------

  async function handleAuth(event: React.FormEvent<HTMLFormElement>) {

    event.preventDefault();

    setError('');

    setNotice('');

    if (isRegister && password !== confirmPassword) {

      setError('Password and confirm password do not match.');

      return;

    }

    setLoading(true);

    try {

      if (isRegister) {

        const profilePhotoDataUrl = signupPhoto ? await fileToDataUrl(signupPhoto) : null;
        const response = await fetch(`${API}/${registerType === 'faculty' ? 'auth/register-faculty' : 'auth/register'}`, {

          method: 'POST',

          headers: { 'Content-Type': 'application/json' },

          body: JSON.stringify(registerType === 'faculty' ? {

            full_name: name.trim(),

            email: email.trim(),

            username: username.trim(),

            password,
            profile_photo_data_url: profilePhotoDataUrl,

          } : {

            full_name: name.trim(),

            student_id: studentId.trim(),

            course: course.trim(),

            year: year.trim(),

            section: section.trim(),

            email: email.trim(),

            username: username.trim(),

            password,
            profile_photo_data_url: profilePhotoDataUrl,

          }),

        });

        await readResponse(response);

        setIsRegister(false);

        setName(''); setStudentId(''); setCourse(''); setYear(''); setSection(''); setEmail(''); setUsername(''); setSignupPhoto(null); setSignupPhotoPreview('');

        setPassword(''); setConfirmPassword('');

        setShowPassword(false); setShowConfirmPassword(false);

        setNotice(`${registerType === 'faculty' ? 'Faculty' : 'Student'} account created successfully. Please log in.`);

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

        if (!data?.access_token) {

          throw new Error('The login response does not contain an access token.');

        }

        // Keep the token only for this browser session unless Remember Me is selected.
        if (rememberMe) {
          localStorage.setItem(TOKEN_KEY, data.access_token);
          sessionStorage.removeItem(TOKEN_KEY);
        } else {
          sessionStorage.setItem(TOKEN_KEY, data.access_token);
          localStorage.removeItem(TOKEN_KEY);
        }

        setToken(data.access_token);

        setUser({

          id: data.id,

          full_name: data.full_name,

          name: data.full_name,

          email: data.email || email.trim(),

          role: data.role,

          student_id: data.student_id,

          username: data.username,

          course: data.course,

          year: data.year,

          section: data.section,
          profile_photo_url: data.profile_photo_url,

        });

        setPage('home');

        setQuery('');

        setSelectedCategory('');

        setPassword('');

        setNotice('');

      }

    } catch (err) {

      setError(getError(err));

    } finally {

      setLoading(false);

    }

  }

  // ---------------------------------------------------------

  // LOGOUT

  // ---------------------------------------------------------

  async function logout() {

    if (token) {

      try {

        await fetch(`${API}/auth/logout`, {

          method: 'POST',

          headers: { Authorization: `Bearer ${token}` },

        });

      } catch (err) {

        console.error('Logout request failed:', err);

      }

    }

    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);

    setToken('');

    setUser(null);

    setBooks([]);

    setAccounts([]);

    setLoginSessions([]);

    setPage('home');

    setQuery('');

    setSelectedCategory('');

    setAccountQuery('');

    setEmail('');

    setPassword('');

    setName('');

    setError('');

    setNotice('');

  }

  // ---------------------------------------------------------

  async function confirmLogout() {
    const dialog = await alertController.create({
      cssClass: 'libtrack-alert libtrack-confirm-alert',
      header: 'Log Out',
      message: 'Are you sure you want to log out of LibTrack?',
      buttons: [
        { text: 'Cancel', role: 'cancel', cssClass: 'libtrack-dialog-cancel' },
        { text: 'Log Out', role: 'confirm', cssClass: 'libtrack-dialog-confirm' },
      ],
      backdropDismiss: false,
    });
    await dialog.present();
    const { role } = await dialog.onDidDismiss();
    if (role === 'confirm') await logout();
  }

  // ---------------------------------------------------------

  // CURRENT USER

  // ---------------------------------------------------------

  useEffect(() => {

    if (!token) {

      setUser(null);

      setUserLoading(false);

      return;

    }

    let cancelled = false;

    async function loadCurrentUser() {

      setUserLoading(true);

      try {

        const response = await fetch(`${API}/auth/me`, {

          headers: { Authorization: `Bearer ${token}` },

        });

        const data = await readResponse(response);

        if (!cancelled) {

          setUser({

            id: data.id,

            full_name: data.full_name,

            name: data.full_name,

            email: data.email,

            role: data.role,

            student_id: data.student_id,

            username: data.username,

            course: data.course,

            year: data.year,

            section: data.section,
            profile_photo_url: data.profile_photo_url,

          });

        }

      } catch (err) {

        if (!cancelled) {

          console.error('Could not load account:', err);

          setError(getError(err));

        }

      } finally {

        if (!cancelled) setUserLoading(false);

      }

    }

    void loadCurrentUser();

    return () => {

      cancelled = true;

    };

  }, [token]);

  // ---------------------------------------------------------

  // BOOK CATALOG

  // ---------------------------------------------------------

  useEffect(() => {

    if (!token) {

      setBooks([]);

      return;

    }

    let cancelled = false;

    async function loadBooks() {

      setBooksLoading(true);

      try {

        const response = await fetch(

          `${API}/books?q=${encodeURIComponent(query)}`,

        );

        const data = await readResponse(response);

        if (!cancelled) {

          setBooks(Array.isArray(data) ? data : []);

        }

      } catch (err) {

        if (!cancelled) {

          setError(`Could not load catalog: ${getError(err)}`);

        }

      } finally {

        if (!cancelled) setBooksLoading(false);

      }

    }

    const timer = window.setTimeout(() => {

      void loadBooks();

    }, 250);

    return () => {

      cancelled = true;

      window.clearTimeout(timer);

    };

  }, [token, query]);

  // ---------------------------------------------------------

  // LOGIN HEARTBEAT

  // ---------------------------------------------------------

  useEffect(() => {

    if (!token || !user) return;

    let cancelled = false;

    async function sendHeartbeat() {

      try {

        const response = await fetch(`${API}/auth/heartbeat`, {

          method: 'POST',

          headers: { Authorization: `Bearer ${token}` },

        });

        if (!response.ok && !cancelled) {

          console.warn('Heartbeat failed:', response.status);

        }

      } catch (err) {

        if (!cancelled) console.error('Heartbeat error:', err);

      }

    }

    void sendHeartbeat();

    const timer = window.setInterval(() => {

      void sendHeartbeat();

    }, 30000);

    return () => {

      cancelled = true;

      window.clearInterval(timer);

    };

  }, [token, user?.id]);

  // ---------------------------------------------------------

  // ADMIN: ALL REGISTERED ACCOUNTS

  // ---------------------------------------------------------

  useEffect(() => {

    if (!token || !isAdmin) {

      setAccounts([]);

      setAccountsError('');

      setAccountsLoading(false);

      return;

    }

    let cancelled = false;

    async function loadAccounts() {

      setAccountsLoading(true);

      try {

        const response = await fetch(`${API}/users`, {

          headers: { Authorization: `Bearer ${token}` },

        });

        const data = await readResponse(response);

        if (!cancelled) {

          setAccounts(Array.isArray(data) ? data : []);

          setAccountsError('');

        }

      } catch (err) {

        if (!cancelled) {

          setAccountsError(getError(err));

        }

      } finally {

        if (!cancelled) setAccountsLoading(false);

      }

    }

    void loadAccounts();

    const timer = window.setInterval(() => {

      void loadAccounts();

    }, 15000);

    return () => {

      cancelled = true;

      window.clearInterval(timer);

    };

  }, [token, isAdmin]);

  // ---------------------------------------------------------
  // STUDENT: WATCH FOR BOOKS BORROWED BY OTHER USERS WITHOUT A PAGE REFRESH
  // Poll the catalog and notify when an available-copy count decreases.
  // ---------------------------------------------------------

  useEffect(() => {
    if (!token || !isStudent) {
      bookAvailabilitySnapshotRef.current = null;
      return;
    }

    let cancelled = false;
    const checkBookAvailability = async () => {
      try {
        const response = await fetch(`${API}/books`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await readResponse(response);
        if (cancelled || !Array.isArray(data)) return;

        const latestBooks = data as Book[];
        const latestSnapshot = new Map<number, number>(
          latestBooks.map((book) => [Number(book.id), Number(book.available_copies) || 0] as [number, number])
        );
        const previousSnapshot = bookAvailabilitySnapshotRef.current;

        bookAvailabilitySnapshotRef.current = latestSnapshot;
        setBooks((current) => {
          const currentById = new Map(current.map((book) => [book.id, book]));
          return latestBooks.map((book) => ({ ...currentById.get(book.id), ...book }));
        });
      } catch (err) {
        // Keep the current catalog visible; the next poll will retry.
        console.warn('Could not check book availability updates:', err);
      }
    };

    void checkBookAvailability();
    // Refresh student catalog frequently so an Admin approval appears without manual reload.
    const timer = window.setInterval(() => { void checkBookAvailability(); }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [token, isStudent]);

  // ---------------------------------------------------------
  // ADMIN HOME: STUDENTS WITH THE MOST BORROWINGS
  // Pending requests are excluded; approved and returned transactions count.
  // ---------------------------------------------------------

  useEffect(() => {
    if (!token || !isAdmin || page !== 'home') return;

    let cancelled = false;
    const loadMostBorrowingStudents = async () => {
      try {
        const response = await fetch(`${API}/reports/most-borrowing-students?limit=10`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await readResponse(response);
        if (!cancelled) setMostBorrowingStudents(Array.isArray(data) ? data : []);
      } catch (err) {
        console.warn('Could not load most-borrowing students:', err);
      }
    };

    void loadMostBorrowingStudents();
    const timer = window.setInterval(() => void loadMostBorrowingStudents(), 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [token, isAdmin, page]);

  // ---------------------------------------------------------
  // HOME: MOST BORROWED BOOKS
  // Counts only approved borrowing transactions (borrowed/returned).
  // ---------------------------------------------------------

  useEffect(() => {
    if (!token || page !== 'home') return;

    let cancelled = false;

    const loadMostBorrowedBooks = async () => {
      try {
        const response = await fetch(`${API}/reports/most-borrowed?limit=6`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await readResponse(response);
        if (!cancelled) {
          setMostBorrowedBooks(Array.isArray(data) ? data : []);
        }
      } catch (err) {
        // Keep the Home page usable if the ranking endpoint is temporarily unavailable.
        console.warn('Could not load most-borrowed books:', err);
      }
    };

    void loadMostBorrowedBooks();
    const timer = window.setInterval(() => {
      void loadMostBorrowedBooks();
    }, 15000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [token, page]);

  // ---------------------------------------------------------

  // ---------------------------------------------------------
  // ANDROID LOCAL DUE-DATE REMINDERS
  // ---------------------------------------------------------
  // These reminders are scheduled on the student's Android device.
  // They continue to fire while the app is closed after they have been
  // scheduled. A device must sync the borrowing record at least once.
  async function syncDueDateReminders(records: Borrowing[]) {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android' || !isStudentAccount) {
      return;
    }

    const activeRecords = records
      .filter((record) => record.status === 'borrowed' && !record.returned_at && /^\d{4}-\d{2}-\d{2}$/.test(record.due_date))
      .sort((a, b) => a.id - b.id);

    const signature = activeRecords.map((record) => `${record.id}:${record.due_date}`).join('|') || 'none';
    if (dueReminderSignatureRef.current === signature) return;

    try {
      const pendingResult = await LocalNotifications.getPending();
      const managedPending = (pendingResult.notifications || []).filter(
        (item) => item.extra?.libtrackReminder === true
      );

      // Pending notifications that no longer match an active borrowing are removed.
      const activeIds = new Set(activeRecords.map((record) => record.id));
      const stalePending = managedPending.filter((item) => {
        const borrowingId = Number(item.extra?.borrowingId);
        return !activeIds.has(borrowingId);
      });
      if (stalePending.length) {
        await LocalNotifications.cancel({
          notifications: stalePending.map((item) => ({ id: item.id })),
        });
      }

      if (!activeRecords.length) {
        dueReminderSignatureRef.current = signature;
        return;
      }

      let permission = await LocalNotifications.checkPermissions();
      if (permission.display !== 'granted') {
        permission = await LocalNotifications.requestPermissions();
      }
      if (permission.display !== 'granted') {
        console.warn('LibTrack due-date reminders are disabled because notification permission was not granted.');
        dueReminderSignatureRef.current = signature;
        return;
      }

      await LocalNotifications.createChannel({
        id: 'libtrack-due-reminders',
        name: 'Book Due-Date Reminders',
        description: 'Reminders one day before and on the book return due date',
        importance: 5,
        vibration: true,
      });

      const booksResponse = await fetch(`${API}/books`);
      const bookRows = await readResponse(booksResponse);
      const bookTitleById = new Map<number, string>(
        (Array.isArray(bookRows) ? bookRows : []).map((book: Book) => [book.id, book.title] as [number, string])
      );

      const now = Date.now();
      const desiredNotifications: Array<{
        id: number;
        title: string;
        body: string;
        at: Date;
        borrowingId: number;
        dueDate: string;
        reminderKind: 'day_before' | 'due_today';
      }> = [];

      for (const record of activeRecords) {
        // IDs are deterministic, so repeated syncs do not create duplicates.
        const baseId = record.id * 2;
        if (!Number.isSafeInteger(baseId) || baseId < 0 || baseId + 2 > 2147483647) {
          console.warn(`Skipping due-date reminders for borrowing #${record.id}: notification ID is out of range.`);
          continue;
        }

        const title = bookTitleById.get(record.book_id) || 'your borrowed book';
        const dueDay = new Date(`${record.due_date}T08:00:00+08:00`);
        // Manila has no daylight-saving changes, so subtract exactly 24 hours.
        const dayBefore = new Date(dueDay.getTime() - 24 * 60 * 60 * 1000);

        if (dayBefore.getTime() > now) {
          desiredNotifications.push({
            id: baseId + 1,
            title: 'Book due tomorrow',
            body: `Please remember to return “${title}” tomorrow (${record.due_date}).`,
            at: dayBefore,
            borrowingId: record.id,
            dueDate: record.due_date,
            reminderKind: 'day_before',
          });
        }

        if (dueDay.getTime() > now) {
          desiredNotifications.push({
            id: baseId + 2,
            title: 'Book due today',
            body: `Today is the return due date for “${title}”. Please return it to the library.`,
            at: dueDay,
            borrowingId: record.id,
            dueDate: record.due_date,
            reminderKind: 'due_today',
          });
        }
      }

      const desiredById = new Map(desiredNotifications.map((item) => [item.id, item]));
      const outdatedPending = managedPending.filter((item) => {
        const desired = desiredById.get(item.id);
        return !desired ||
          item.extra?.dueDate !== desired.dueDate ||
          item.extra?.reminderKind !== desired.reminderKind;
      });
      if (outdatedPending.length) {
        await LocalNotifications.cancel({
          notifications: outdatedPending.map((item) => ({ id: item.id })),
        });
      }

      const cancelledIds = new Set(outdatedPending.map((item) => item.id));
      const stillPendingIds = new Set(
        managedPending.filter((item) => !cancelledIds.has(item.id)).map((item) => item.id)
      );
      const notificationsToSchedule = desiredNotifications
        .filter((item) => !stillPendingIds.has(item.id))
        .map((item) => ({
          id: item.id,
          title: item.title,
          body: item.body,
          schedule: { at: item.at },
          channelId: 'libtrack-due-reminders',
          extra: {
            libtrackReminder: true,
            borrowingId: item.borrowingId,
            dueDate: item.dueDate,
            reminderKind: item.reminderKind,
          },
        }));

      if (notificationsToSchedule.length) {
        await LocalNotifications.schedule({ notifications: notificationsToSchedule });
      }

      dueReminderSignatureRef.current = signature;
    } catch (err) {
      // Notification failures must never interrupt borrowing history or the dashboard.
      console.warn('Could not sync LibTrack Android due-date reminders:', err);
    }
  }

  // BORROWING ACTIVITY / STUDENT BORROWING HISTORY

  // The backend returns all records to admins and only the signed-in student's
  // own records to students. Poll to keep both views up to date.

  // ---------------------------------------------------------

  useEffect(() => {

    if (!token) {

      setBorrowings([]);

      setBorrowingsError('');

      setBorrowingsLoading(false);

      return;

    }

    let cancelled = false;

    async function loadBorrowings() {

      try {

        if (!cancelled && borrowings.length === 0) setBorrowingsLoading(true);

        const response = await fetch(`${API}/borrowings`, {

          headers: { Authorization: `Bearer ${token}` },

        });

        const data = await readResponse(response);

        if (!cancelled) {

          setBorrowings(Array.isArray(data) ? data : []);

          setBorrowingsError('');

          if (isStudentAccount) {
            void syncDueDateReminders(Array.isArray(data) ? data as Borrowing[] : []);
          }

        }

      } catch (err) {

        if (!cancelled) setBorrowingsError(getError(err));

      } finally {

        if (!cancelled) setBorrowingsLoading(false);

      }

    }

    void loadBorrowings();

    const timer = window.setInterval(() => { void loadBorrowings(); }, 10000);
    if (isAdmin) void loadLostBookCases();

    return () => {

      cancelled = true;

      window.clearInterval(timer);

    };

  }, [token, isAdmin, isStudentAccount]);

  // ---------------------------------------------------------

  // ADMIN: ACTIVE LOGIN SESSIONS

  // ---------------------------------------------------------

  useEffect(() => {

    if (!token || !isAdmin) {

      setLoginSessions([]);

      setSessionsError('');

      setSessionsLoading(false);

      return;

    }

    let cancelled = false;

    async function loadSessions() {

      setSessionsLoading(true);

      try {

        const response = await fetch(`${API}/admin/sessions`, {

          headers: { Authorization: `Bearer ${token}` },

        });

        const data = await readResponse(response);

        if (!cancelled) {

          setLoginSessions(Array.isArray(data) ? data : []);

          setSessionsError('');

        }

      } catch (err) {

        if (!cancelled) {

          setSessionsError(getError(err));

        }

      } finally {

        if (!cancelled) setSessionsLoading(false);

      }

    }

    void loadSessions();

    const timer = window.setInterval(() => {

      void loadSessions();

    }, 15000);

    return () => {

      cancelled = true;

      window.clearInterval(timer);

    };

  }, [token, isAdmin]);

  // Keep the borrowing schedule synchronized across separate devices/sessions.
  // Admin changes are saved on the API; student/faculty pages pick them up
  // automatically without requiring a refresh or a new sign-in.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const refreshBorrowingSchedule = async () => {
      try {
        const response = await fetch(`${API}/settings/borrowing-schedule`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        const data = await readResponse(response);
        if (!cancelled && data?.schedule) {
          setBorrowingSchedule((current) => ({ ...current, ...data.schedule }));
        }
      } catch (err) {
        if (!cancelled) console.error('Could not refresh borrowing schedule:', err);
      }
    };

    void refreshBorrowingSchedule();
    const refreshTimer = window.setInterval(() => {
      void refreshBorrowingSchedule();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(refreshTimer);
    };
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch(`${API}/settings/library-schedule`, { headers: { Authorization: `Bearer ${token}` } })
      .then(readResponse)
      .then((data) => { if (!cancelled && data?.schedule) setLibrarySchedule((current) => ({ ...current, ...data.schedule })); })
      .catch((err) => { if (!cancelled) console.error('Could not load library schedule:', err); });
    return () => { cancelled = true; };
  }, [token]);

  async function saveBorrowingSchedule() {
    if (!token || !isAdmin) {
      setBorrowingScheduleMessage('Only an Admin can save the borrowing schedule.');
      return;
    }
    setBorrowingScheduleSaving(true);
    setBorrowingScheduleMessage('Saving borrowing schedule...');
    try {
      const response = await fetch(`${API}/settings/borrowing-schedule`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(borrowingSchedule),
      });
      const data = await readResponse(response);
      if (!data?.schedule) throw new Error('The server did not return the saved borrowing schedule.');
      setBorrowingSchedule((current) => ({ ...current, ...data.schedule }));
      setBorrowingScheduleMessage('Borrowing schedule saved successfully.');
    } catch (err) {
      setBorrowingScheduleMessage(`Could not save borrowing schedule: ${getError(err)}`);
    } finally {
      setBorrowingScheduleSaving(false);
    }
  }

  function isBorrowingScheduleOpenNow() {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Manila', weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).reduce((acc: Record<string, string>, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
    const currentTime = `${parts.hour}:${parts.minute}`;
    return borrowingSchedule.enabled
      && borrowingSchedule.days.includes(parts.weekday)
      && currentTime >= borrowingSchedule.open_time
      && currentTime < borrowingSchedule.close_time;
  }

  async function saveLibrarySchedule() {
    if (!token) {
      setLibraryScheduleMessage('Hindi ma-save: walang active login session. Mag-sign in ulit bilang Admin.');
      return;
    }

    setLibraryScheduleSaving(true);
    setLibraryScheduleMessage('Saving library schedule...');
    try {
      const response = await fetch(`${API}/settings/library-schedule`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ schedule: librarySchedule }),
      });
      const data = await readResponse(response);

      if (!data?.schedule) {
        throw new Error('Walang schedule data na ibinalik ng server. Hindi makumpirma ang pag-save.');
      }

      setLibrarySchedule((current) => ({ ...current, ...data.schedule }));
      setLibraryScheduleMessage('Library schedule saved successfully.');
    } catch (err) {
      setLibraryScheduleMessage(`Hindi na-save ang Library Schedule: ${getError(err)}`);
    } finally {
      setLibraryScheduleSaving(false);
    }
  }

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch(`${API}/settings/weekend-notice`, { headers: { Authorization: `Bearer ${token}` } })
      .then(readResponse)
      .then((data) => {
        if (cancelled) return;
        setWeekendNoticeEnabled(Boolean(data.enabled));
        setWeekendNoticeTime(data.time || '07:00');
        setWeekendNoticeMessage(data.message || 'Book borrowing is unavailable on Saturdays and Sundays. Please visit the library during regular operating days (Monday-Friday).');
      })
      .catch((err) => { if (!cancelled) console.error('Could not load weekend notice settings:', err); });
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => {
    if (!token || !user || isAdmin || !weekendNoticeEnabled) {
      setShowWeekendNoticePopup(false);
      return;
    }
    const checkSchedule = () => {
      const now = new Date();
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Manila', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(now).reduce((acc: Record<string, string>, part) => {
        acc[part.type] = part.value; return acc;
      }, {});
      if (parts.weekday !== 'Sat' && parts.weekday !== 'Sun') { setShowWeekendNoticePopup(false); return; }
      const currentTime = `${parts.hour}:${parts.minute}`;
      const dayKey = `${parts.year}-${parts.month}-${parts.day}`;
      const shownKey = `libtrack_weekend_notice_shown_${dayKey}`;
      if (currentTime >= weekendNoticeTime && localStorage.getItem(shownKey) !== '1') {
        localStorage.setItem(shownKey, '1');
        setShowWeekendNoticePopup(true);
      }
    };
    checkSchedule();
    const timer = window.setInterval(checkSchedule, 15000);
    return () => window.clearInterval(timer);
  }, [token, user, isAdmin, weekendNoticeEnabled, weekendNoticeTime]);

  async function checkAdminApiHealth() {
    setApiHealthStatus('checking');
    setApiHealthMessage('Checking backend connection...');
    try {
      const response = await fetch(`${API}/health`, {
        method: 'GET',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error(`Backend returned HTTP ${response.status}.`);
      await response.json().catch(() => null);
      setApiHealthStatus('online');
      setApiHealthMessage('Backend API is reachable.');
    } catch (err) {
      setApiHealthStatus('offline');
      setApiHealthMessage(`Backend API is not reachable: ${getError(err)}`);
    }
  }

  async function saveWeekendNoticeSettings() {
    if (!token) {
      setWeekendNoticeSaveMessage('Hindi ma-save: nawawala ang login session. Mag-sign in ulit.');
      return;
    }

    setWeekendNoticeSaving(true);
    setWeekendNoticeSaveMessage('Saving weekend notice settings...');
    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 15000);
      let response: Response;
      try {
        response = await fetch(`${API}/settings/weekend-notice`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            enabled: weekendNoticeEnabled,
            time: weekendNoticeTime,
            message: weekendNoticeMessage.trim(),
          }),
          signal: controller.signal,
        });
      } finally {
        window.clearTimeout(timeout);
      }

      const data = await readResponse(response);
      if (typeof data.enabled !== 'boolean' || !data.time || typeof data.message !== 'string') {
        throw new Error('Hindi kumpleto ang response ng server. Pakisuri ang weekend-notice API.');
      }

      setWeekendNoticeEnabled(data.enabled);
      setWeekendNoticeTime(data.time);
      setWeekendNoticeMessage(data.message);
      setWeekendNoticeSaveMessage('Weekend borrowing notice settings saved successfully.');
    } catch (err) {
      const message = err instanceof Error && err.name === 'AbortError'
        ? 'Nag-timeout ang request. Tingnan kung tumatakbo ang backend.'
        : getError(err);
      setWeekendNoticeSaveMessage(`Hindi na-save ang Weekend Borrowing Notice: ${message}`);
    } finally {
      setWeekendNoticeSaving(false);
    }
  }

  // ---------------------------------------------------------

  // BOOK MANAGEMENT

  // ---------------------------------------------------------

  // STUDENT: FIRST ASK FOR CONFIRMATION, THEN SUBMIT THE BORROWING REQUEST.
  function borrowBook(book: Book) {
    if (!isBorrowingScheduleOpenNow()) {
      setError(borrowingSchedule.message || 'Book borrowing is currently unavailable. Please check the library borrowing schedule.');
      return;
    }
    if (!token || isAdmin) {
      setError('Please log in with a student account to request a book.');
      return;
    }
    if (book.available_copies < 1 || !book.available) {
      setError('No copies of this book are currently available.');
      return;
    }
    setError('');
    setNotice('');
    setBorrowRequestConfirmation(book);
  }

  async function submitBorrowRequest(book: Book) {
    if (!token || isAdmin || loading) return;
    setLoading(true);
    setError('');
    setNotice('');
    const requestController = new AbortController();
    const requestTimeout = window.setTimeout(() => requestController.abort(), 15000);
    try {
      const response = await fetch(`${API}/borrowings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ book_id: book.id }),
        signal: requestController.signal,
      });
      const createdRecord = await readResponse(response);

      // Immediately reflect the saved request in the student's borrowing history.
      // The Admin dashboard independently polls GET /borrowings and will receive
      // this same persisted pending record on its next refresh.
      if (createdRecord && typeof createdRecord.id === 'number') {
        setBorrowings((current) => [
          createdRecord as Borrowing,
          ...current.filter((item) => item.id !== createdRecord.id),
        ]);
      }

      setBorrowRequestConfirmation(null);
      setNotice(`Your request for “${book.title}” was submitted successfully and is now Pending Approval. You can check its status in My Books / History.`);

      const [booksResponse, borrowingsResponse] = await Promise.all([
        fetch(`${API}/books?q=${encodeURIComponent(query)}`),
        fetch(`${API}/borrowings`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      const [refreshedBooks, refreshedBorrowings] = await Promise.all([
        readResponse(booksResponse),
        readResponse(borrowingsResponse),
      ]);
      setBooks(Array.isArray(refreshedBooks) ? refreshedBooks : []);
      setBorrowings(Array.isArray(refreshedBorrowings) ? refreshedBorrowings : []);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setError(`The borrowing request timed out after 15 seconds. Please check that the LibTrack backend is running and that VITE_API_URL is correct (${API}), then try again.`);
      } else {
        const borrowError = getError(err);
        const normalizedBorrowError = borrowError.toLowerCase();
        const isLostDamagedRestriction =
          normalizedBorrowError.includes('borrowing privileges are suspended') ||
          normalizedBorrowError.includes('unsettled lost/damaged book case') ||
          normalizedBorrowError.includes('unsettled lost or damaged book case');

        if (isLostDamagedRestriction) {
          setError('');
          setBorrowRequestConfirmation(null);
          const restrictionAlert = await alertController.create({
            header: 'Borrowing Restricted',
            message:
              'Your library borrowing privileges are temporarily suspended because you have an unsettled lost or damaged book case. Please visit or contact the Librarian to settle your case before borrowing another book.',
            buttons: [{ text: 'Okay', role: 'confirm' }],
            cssClass: 'libtrack-alert',
            backdropDismiss: true,
          });
          await restrictionAlert.present();
        } else {
          setError(`Could not submit the borrowing request: ${borrowError}`);
        }
      }
    } finally {
      window.clearTimeout(requestTimeout);
      setLoading(false);
    }
  }

  async function approveBorrowing(record: Borrowing, dueDate: string) {
    if (!token || !isAdmin) return;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const maxDueDate = new Date(today);
    maxDueDate.setDate(maxDueDate.getDate() + 7);
    const formatLocalDate = (value: Date) =>
      `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) ||
      dueDate < formatLocalDate(today) ||
      dueDate > formatLocalDate(maxDueDate)
    ) {
      setError('Please choose a return due date within the next 7 days.');
      return;
    }
    setLoading(true);
    setError('');
    setNotice('');
    try {
      await readResponse(await fetch(`${API}/borrowings/${record.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ due_date: dueDate }),
      }));
      const response = await fetch(`${API}/borrowings`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await readResponse(response);
      setBorrowings(Array.isArray(data) ? data : []);
      const booksResponse = await fetch(`${API}/books`);
      const refreshedBooks = await readResponse(booksResponse);
      setBooks(Array.isArray(refreshedBooks) ? refreshedBooks : []);
      setNotice(`Borrowing request #${record.id} approved. Return due date: ${dueDate}.`);
    } catch (err) {
      setError(`Could not approve the borrowing request: ${getError(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function returnBorrowing(record: Borrowing) {
    if (!token || !isAdmin || record.status !== 'borrowed') return;
    setLoading(true);
    setError('');
    setNotice('');
    try {
      await readResponse(await fetch(`${API}/borrowings/${record.id}/return`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }));
      const response = await fetch(`${API}/borrowings`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await readResponse(response);
      setBorrowings(Array.isArray(data) ? data : []);
      const booksResponse = await fetch(`${API}/books`);
      const refreshedBooks = await readResponse(booksResponse);
      setBooks(Array.isArray(refreshedBooks) ? refreshedBooks : []);
      setNotice(`Book return recorded successfully for borrowing record #${record.id}.`);
    } catch (err) {
      setError(`Could not record the book return: ${getError(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function loadStudentNotifications() {
    if (!token || isAdmin) return;
    setStudentNotificationsLoading(true);
    try {
      const response = await fetch(`${API}/notifications`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await readResponse(response);
      const rows: UserNotification[] = Array.isArray(data) ? data : [];

      // On the first load, show the newest unread case notice once.
      // On later polls, show a popup only for notifications that just arrived.
      const firstLoad = !studentNotificationsInitializedRef.current;
      const newRows = rows.filter((item) => !seenStudentNotificationIdsRef.current.has(item.id));
      rows.forEach((item) => seenStudentNotificationIdsRef.current.add(item.id));
      studentNotificationsInitializedRef.current = true;
      setStudentNotifications(rows);

      const popupItem = firstLoad
        ? rows.find((item) => !item.is_read && item.notification_type === 'lost_damaged_book')
        : newRows.find((item) => item.notification_type === 'lost_damaged_book');

      if (popupItem && !studentNotificationPopupBusyRef.current) {
        studentNotificationPopupBusyRef.current = true;
        try {
          const dialog = await alertController.create({
            cssClass: 'libtrack-alert libtrack-success-alert',
            header: popupItem.title || 'Library Notice',
            message: popupItem.message,
            buttons: [{ text: 'View Notifications', role: 'confirm', cssClass: 'libtrack-dialog-confirm' }],
            backdropDismiss: false,
          });
          await dialog.present();
          await dialog.onDidDismiss();
        } finally {
          studentNotificationPopupBusyRef.current = false;
        }
      }
    } catch {
      // Keep the rest of the student dashboard usable if notifications cannot load.
    } finally {
      setStudentNotificationsLoading(false);
    }
  }

  async function markStudentNotificationRead(notificationId: number) {
    if (!token) return;
    try {
      await readResponse(await fetch(`${API}/notifications/${notificationId}/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }));
      setStudentNotifications((items) => items.map((item) => item.id === notificationId ? { ...item, is_read: true } : item));
      setSelectedStudentNotification((item) => item?.id === notificationId ? { ...item, is_read: true } : item);
    } catch {
      // The notification remains visible; it can be marked read on the next attempt.
    }
  }

  async function loadLostBookCases() {
    if (!token || !isAdmin) return;
    setLostCasesLoading(true);
    try {
      const response = await fetch(`${API}/lost-books`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await readResponse(response);
      setLostBookCases(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(`Could not load lost/damaged book records: ${getError(err)}`);
    } finally {
      setLostCasesLoading(false);
    }
  }

  function reportLostBook(record: Borrowing, caseType: 'lost' | 'damaged') {
    if (!token || !isAdmin) return;
    setLostBookMarketValue('0'); setLostBookAdditionalFine('0'); setLostBookNote('');
    setLostBookDialog({ mode: 'report', record, caseType });
  }

  function openResolveLostBookCase(item: LostBookCase, resolution: 'paid' | 'replaced') {
    if (!token || !isAdmin) return;
    setLostBookNote('');
    setLostBookReceiptNumber('');
    setLostBookAmountPaid('');
    setLostBookPaymentDate(new Date().toISOString().slice(0, 10));
    setLostBookPaymentMethod('Cash');
    setLostBookReplacementTitle('');
    setLostBookReplacementDate(new Date().toISOString().slice(0, 10));
    setLostBookReceivedBy('');
    setLostBookReceiptFile(null);
    setLostBookDialog({ mode: 'resolve', item, resolution });
  }

  async function submitLostBookDialog() {
    if (!token || !isAdmin || !lostBookDialog) return;
    const dialog = lostBookDialog;
    if (dialog.mode === 'report') {
      const marketValue = Number(lostBookMarketValue);
      const additionalFine = Number(lostBookAdditionalFine);
      if (!Number.isFinite(marketValue) || marketValue < 0) { setError('Please enter a valid current book value.'); return; }
      if (!Number.isFinite(additionalFine) || additionalFine < 0) { setError('Please enter a valid additional fine.'); return; }
      if (!dialog.record || !dialog.caseType) return;
      setLoading(true); setError(''); setNotice('');
      try {
        await readResponse(await fetch(`${API}/borrowings/${dialog.record.id}/report-lost`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ market_value: marketValue, additional_fine: additionalFine, case_type: dialog.caseType, note: lostBookNote.trim() }),
        }));
        const [br, cr, booksRes] = await Promise.all([
          fetch(`${API}/borrowings`, { headers: { Authorization: `Bearer ${token}` } }),
          fetch(`${API}/lost-books`, { headers: { Authorization: `Bearer ${token}` } }),
          fetch(`${API}/books`),
        ]);
        const [bd, cd, booksData] = await Promise.all([readResponse(br), readResponse(cr), readResponse(booksRes)]);
        setBorrowings(Array.isArray(bd) ? bd : []);
        setLostBookCases(Array.isArray(cd) ? cd : []);
        setBooks(Array.isArray(booksData) ? booksData : []);
        setLostBookDialog(null);
        setNotice(`Recorded ${dialog.caseType} book case. Borrowing privileges are suspended until the case is settled.`);
      } catch (err) { setError(`Could not report the book: ${getError(err)}`); }
      finally { setLoading(false); }
      return;
    }
    if (!dialog.item || !dialog.resolution) return;
    if (dialog.resolution === 'paid') {
      const amount = Number(lostBookAmountPaid);
      if (!lostBookAmountPaid.trim() || !Number.isFinite(amount) || amount <= 0) {
        setError('Please enter a valid amount paid.');
        return;
      }
      if (amount > Number(dialog.item.amount_due ?? Number.MAX_SAFE_INTEGER)) {
        setError('Amount paid cannot exceed the case amount due.');
        return;
      }
    }
    if (dialog.resolution === 'replaced' && !lostBookReplacementTitle.trim()) {
      setError('Please enter the replacement book title.');
      return;
    }
    const resolutionDetails = dialog.resolution === 'paid'
      ? [
          `Receipt Number: ${lostBookReceiptNumber.trim() || 'Not provided'}`,
          `Amount Paid: PHP ${Number(lostBookAmountPaid).toFixed(2)}`,
          `Payment Date: ${lostBookPaymentDate}`,
          `Payment Method: ${lostBookPaymentMethod}`,
          lostBookNote.trim() ? `Other Notes: ${lostBookNote.trim()}` : '',
          lostBookReceiptFile ? `Receipt Attachment: ${lostBookReceiptFile.name}` : '',
        ].filter(Boolean).join(' | ')
      : [
          `Receipt Number: ${lostBookReceiptNumber.trim() || 'Not provided'}`,
          `Replacement Book Title: ${lostBookReplacementTitle.trim()}`,
          `Date Received: ${lostBookReplacementDate}`,
          `Received / Checked By: ${lostBookReceivedBy.trim() || 'Not provided'}`,
          lostBookNote.trim() ? `Reference Note: ${lostBookNote.trim()}` : '',
          lostBookReceiptFile ? `Receipt Attachment: ${lostBookReceiptFile.name}` : '',
        ].filter(Boolean).join(' | ');
    setLoading(true); setError(''); setNotice('');
    try {
      let uploadedReceiptKey = '';
      if (lostBookReceiptFile) {
        const receiptForm = new FormData();
        receiptForm.append('file', lostBookReceiptFile);
        const uploadResult = await readResponse(await fetch(`${API}/lost-books/${dialog.item.id}/receipt`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: receiptForm,
        }));
        uploadedReceiptKey = String(uploadResult?.storage_key || '');
      }
      await readResponse(await fetch(`${API}/lost-books/${dialog.item.id}/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ resolution_status: dialog.resolution, note: resolutionDetails }),
      }));
      const previewCase: LostBookCase = {
        ...dialog.item,
        resolution_status: dialog.resolution,
        resolution_note: [
          resolutionDetails,
          uploadedReceiptKey ? `Receipt Storage Key: ${uploadedReceiptKey}` : '',
        ].filter(Boolean).join(' | '),
        resolved_at: new Date().toISOString(),
      };
      setLostBookDialog(null);
      setReceiptPreviewCase(previewCase);
      await loadLostBookCases();
      setNotice(`Lost/damaged book case #${dialog.item.id} marked ${dialog.resolution}. Receipt preview is ready.`);
    } catch (err) { setError(`Could not resolve the case: ${getError(err)}`); }
    finally { setLoading(false); }
  }

  async function viewReceiptAttachment(item: LostBookCase) {
    if (!token) return;
    setReceiptAttachmentLoading(true);
    setReceiptAttachmentUrl(null);
    try {
      const response = await fetch(`${API}/lost-books/${item.id}/receipt`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(await response.text());
      const blob = await response.blob();
      setReceiptAttachmentUrl(URL.createObjectURL(blob));
    } catch (err) {
      setError(`Could not open receipt attachment: ${getError(err)}`);
    } finally {
      setReceiptAttachmentLoading(false);
    }
  }

  async function reuploadReceiptAttachment(item: LostBookCase, file: File) {
    if (!token || !file) return;
    setReceiptReuploadLoading(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      await readResponse(await fetch(`${API}/lost-books/${item.id}/receipt`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      }));

      const oldParts = (item.resolution_note || '').split(' | ').filter(Boolean)
        .filter((part) => !/^Receipt Attachment:/i.test(part) && !/^Receipt Storage Key:/i.test(part));
      const updatedItem = {
        ...item,
        resolution_note: [...oldParts, `Receipt Attachment: ${file.name}`].join(' | '),
      };
      setReceiptPreviewCase(updatedItem);
      await loadLostBookCases();
      setNotice('Receipt uploaded successfully. You can now open its preview.');
      await viewReceiptAttachment(updatedItem);
    } catch (err) {
      setError(`Could not upload receipt attachment: ${getError(err)}`);
    } finally {
      setReceiptReuploadLoading(false);
    }
  }

  const availableCourseOptions = useMemo(() => [
    ...RESEARCH_COURSE_OPTIONS,
    ...additionalCourses.map((code) => ({ value: code, shortName: code, label: code, description: 'Additional course collection' })),
  ], [additionalCourses]);

  async function loadAdditionalCourses() {
    try {
      const response = await fetch(`${API}/courses`);
      const data = await readResponse(response);
      setAdditionalCourses(Array.isArray(data) ? data.filter((code: unknown) => typeof code === 'string' && !['BSIT', 'BSBA', 'BSED'].includes(code.toUpperCase())) : []);
    } catch (err) {
      setError(`Could not load added courses: ${getError(err)}`);
    }
  }

  async function addCourse() {
    if (!isAdmin || !token) return;
    const entered = await libtrackPrompt('Enter the new course name or code (example: BSCRIM).');
    const code = String(entered || '').trim().toUpperCase();
    if (!code) return;
    try {
      await readResponse(await fetch(`${API}/courses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ code }),
      }));
      await loadAdditionalCourses();
      await Promise.all([loadResearchCollectionCovers(), loadEbookCollectionCovers()]);
      setNotice(`${code} course added successfully to both Research Library and E-Book Library.`);
      setEbookUploadCourse(code);
      setEbookUploadYear(`1ST YEAR ${code}`);
      setEbookUploadSemester('1st Semester');
      setEbookUploadSubject('');
      const addCover = await libtrackConfirm(`Add a collection photo for ${code} now?`);
      if (addCover) {
        newCourseCoverTargetRef.current = code;
        ebookCollectionCoverTargetRef.current = code;
        ebookCollectionCoverInputRef.current?.click();
      }
    } catch (err) {
      setError(`Could not add course: ${getError(err)}`);
    }
  }

  async function deleteCourse() {
    if (!isAdmin || !token || additionalCourses.length === 0) return;
    const entered = await libtrackPrompt(`Enter the exact course code to delete:\n${additionalCourses.join(', ')}`);
    const code = String(entered || '').trim().toUpperCase();
    if (!code || !additionalCourses.includes(code)) {
      if (code) setError('Course code not found in the added courses list.');
      return;
    }
    if (!await libtrackConfirm(`Delete course ${code}? This is allowed only when no users, research, or e-books are assigned to it.`)) return;
    try {
      await readResponse(await fetch(`${API}/courses/${encodeURIComponent(code)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }));
      await loadAdditionalCourses();
      setNotice(`${code} course deleted successfully.`);
    } catch (err) {
      setError(`Could not delete course: ${getError(err)}`);
    }
  }

  useEffect(() => {
    seenStudentNotificationIdsRef.current = new Set();
    studentNotificationsInitializedRef.current = false;
    studentNotificationPopupBusyRef.current = false;
    setStudentNotifications([]);
    if (!token || isAdmin) return;
    void loadStudentNotifications();
    const notificationTimer = window.setInterval(() => { void loadStudentNotifications(); }, 15000);
    return () => window.clearInterval(notificationTimer);
  }, [token, isAdmin]);

  useEffect(() => { if (token) void loadAdditionalCourses(); }, [token]);

  async function loadResearchCollectionCovers() {
    try {
      const response = await fetch(`${API}/research/collection-covers`);
      const data = await readResponse(response);
      const covers: Record<string, string> = {};
      for (const [course, value] of Object.entries(data || {})) {
        if (typeof value === 'string' && value) {
          const absolute = value.startsWith('http') ? value : `${API}${value}`;
          covers[course.toUpperCase()] = `${absolute}${absolute.includes('?') ? '&' : '?'}v=${Date.now()}`;
        }
      }
      setResearchCollectionCovers(covers);
    } catch (err) {
      // Keep the bundled default collection covers available if the optional
      // collection-cover endpoint is temporarily unavailable.
      console.warn('Could not load Research Collection covers:', err);
    }
  }

  function chooseResearchCollectionCover(courseCode: string) {
    if (!isAdmin || !token) return;
    researchCollectionCoverTargetRef.current = courseCode;
    researchCollectionCoverInputRef.current?.click();
  }

  async function uploadResearchCollectionCover(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    const courseCode = researchCollectionCoverTargetRef.current;
    if (!file || !courseCode || !token || !isAdmin) {
      if (!file) { ebookCollectionCoverTargetRef.current = null; newCourseCoverTargetRef.current = null; }
      return;
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setError('Collection cover must be JPG, PNG, or WEBP and no larger than 5 MB.');
      researchCollectionCoverTargetRef.current = null;
      return;
    }
    setResearchCollectionCoverUploading(courseCode);
    setError('');
    setNotice('');
    try {
      const body = new FormData();
      body.append('file', file, file.name);
      const result = await readResponse(await fetch(`${API}/research/collection-covers/${courseCode}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body,
      }));
      const url = typeof result?.cover_url === 'string' ? result.cover_url : '';
      if (url) {
        const absolute = url.startsWith('http') ? url : `${API}${url}`;
        setResearchCollectionCovers((current) => ({ ...current, [courseCode]: `${absolute}${absolute.includes('?') ? '&' : '?'}v=${Date.now()}` }));
      } else {
        await loadResearchCollectionCovers();
      }
      setNotice(`${courseCode} Research Collection photo updated successfully.`);
    } catch (err) {
      setError(`Could not update ${courseCode} collection photo: ${getError(err)}`);
    } finally {
      setResearchCollectionCoverUploading(null);
      researchCollectionCoverTargetRef.current = null;
    }
  }

  useEffect(() => { void loadResearchCollectionCovers(); }, []);

  async function loadEbookCollectionCovers() {
    try {
      const response = await fetch(`${API}/ebooks/collection-covers`);
      const data = await readResponse(response);
      const covers: Record<string, string> = {};
      for (const [course, value] of Object.entries(data || {})) {
        if (typeof value === 'string' && value) {
          const absolute = value.startsWith('http') ? value : `${API}${value}`;
          covers[course.toUpperCase()] = `${absolute}${absolute.includes('?') ? '&' : '?'}v=${Date.now()}`;
        }
      }
      setEbookCollectionCovers(covers);
    } catch (err) {
      console.warn('Could not load E-Book Collection covers:', err);
    }
  }

  function chooseEbookCollectionCover(courseCode: string) {
    if (!isAdmin || !token) return;
    ebookCollectionCoverTargetRef.current = courseCode;
    ebookCollectionCoverInputRef.current?.click();
  }

  async function uploadEbookCollectionCover(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    const courseCode = ebookCollectionCoverTargetRef.current;
    if (!file || !courseCode || !token || !isAdmin) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setError('Collection cover must be JPG, PNG, or WEBP and no larger than 5 MB.');
      ebookCollectionCoverTargetRef.current = null;
      newCourseCoverTargetRef.current = null;
      return;
    }
    setEbookCollectionCoverUploading(courseCode);
    setError('');
    setNotice('');
    try {
      const body = new FormData();
      body.append('file', file, file.name);
      const result = await readResponse(await fetch(`${API}/ebooks/collection-covers/${encodeURIComponent(courseCode)}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body,
      }));
      const url = typeof result?.cover_url === 'string' ? result.cover_url : '';
      if (url) {
        const absolute = url.startsWith('http') ? url : `${API}${url}`;
        setEbookCollectionCovers((current) => ({ ...current, [courseCode]: `${absolute}${absolute.includes('?') ? '&' : '?'}v=${Date.now()}` }));
      } else await loadEbookCollectionCovers();
      // If this upload was started immediately after adding a course, use the same
      // selected image for its Research collection card as well.
      if (newCourseCoverTargetRef.current === courseCode) {
        const researchBody = new FormData();
        researchBody.append('file', file, file.name);
        const researchResult = await readResponse(await fetch(`${API}/research/collection-covers/${encodeURIComponent(courseCode)}`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: researchBody,
        }));
        if (typeof researchResult?.cover_url === 'string') {
          const researchUrl = researchResult.cover_url.startsWith('http') ? researchResult.cover_url : `${API}${researchResult.cover_url}`;
          setResearchCollectionCovers((current) => ({ ...current, [courseCode]: `${researchUrl}${researchUrl.includes('?') ? '&' : '?'}v=${Date.now()}` }));
        } else await loadResearchCollectionCovers();
        newCourseCoverTargetRef.current = null;
      }
      setNotice(`${courseCode} E-Book Collection photo updated successfully.`);
    } catch (err) {
      setError(`Could not update ${courseCode} collection photo: ${getError(err)}`);
    } finally {
      setEbookCollectionCoverUploading(null);
      ebookCollectionCoverTargetRef.current = null;
      newCourseCoverTargetRef.current = null;
    }
  }

  useEffect(() => { void loadEbookCollectionCovers(); }, []);

  async function loadResearch() {
    setResearchLoading(true);
    try {
      // Load the full catalog once; search is filtered locally so course counts remain accurate.
      const response = await fetch(`${API}/research`);
      const data = await readResponse(response);
      const rows = Array.isArray(data) ? data : [];
      setResearchItems(rows);
      if (selectedResearchId !== null && !rows.some((item: ResearchMaterial) => item.id === selectedResearchId)) {
        setSelectedResearchId(null);
        setResearchView((current) => current === 'reader' ? 'course' : current);
      }
    } catch (err) {
      setError(`Could not load the Research Library: ${getError(err)}`);
    } finally { setResearchLoading(false); }
  }

  useEffect(() => { if (token) void loadResearch(); }, [token]);

  async function loadEbooks() {
    setEbooksLoading(true);
    setEbooksError('');
    try {
      const response = await fetch(`${API}/ebooks`);
      const data = await readResponse(response);
      setEbooks(Array.isArray(data) ? data : []);
    } catch (err) {
      setEbooksError(`Could not load E-Book Library: ${getError(err)}`);
    } finally {
      setEbooksLoading(false);
    }
  }

  async function loadInventory() {
    if (!isAdmin) return;
    const hasCachedInventory = books.length > 0 || researchItems.length > 0 || ebooks.length > 0;
    if (!hasCachedInventory) setInventoryLoading(true);
    setInventoryError('');
    try {
      const [booksResponse, researchResponse, ebooksResponse] = await Promise.all([
        fetch(`${API}/books`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined }),
        fetch(`${API}/research`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined }),
        fetch(`${API}/ebooks`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined }),
      ]);
      const [bookRows, researchRows, ebookRows] = await Promise.all([
        readResponse(booksResponse), readResponse(researchResponse), readResponse(ebooksResponse),
      ]);
      setBooks(Array.isArray(bookRows) ? bookRows : []);
      setResearchItems(Array.isArray(researchRows) ? researchRows : []);
      setEbooks(Array.isArray(ebookRows) ? ebookRows : []);
    } catch (err) {
      // Preserve cached data if the network is temporarily unavailable.
      if (!hasCachedInventory) {
        setInventoryError(`Could not load complete inventory: ${getError(err)}`);
      }
    } finally {
      setInventoryLoading(false);
    }
  }

  useEffect(() => {
    if (page === 'inventory' && isAdmin && token) void loadInventory();
  }, [page, isAdmin, token]);

  function exportInventoryCsv() {
    const escapeCell = (value: unknown) => {
      const text = value === null || value === undefined ? '' : String(value);
      return `"${text.replace(/"/g, '""')}"`;
    };

    // Two-column vertical layout: field names in column A, values in column B.
    // Each inventory record gets its own block so WPS/Excel does not need
    // horizontal scrolling to read the exported file.
    const rows: unknown[][] = [];
    const addField = (label: string, value: unknown = '') => {
      rows.push([label, value]);
    };
    const addBlankLine = () => rows.push([]);

    let filename = 'libtrack-inventory';

    if (inventoryTab === 'books') {
      filename += '-books';
      addField('LIBTRACK LIBRARY INVENTORY', 'PHYSICAL BOOKS');
      addField('Total Book Titles', books.length);
      addField('Total Copies', books.reduce((sum, item) => sum + (Number(item.total_copies) || 0), 0));
      addField('Total Available Copies', books.reduce((sum, item) => sum + (Number(item.available_copies) || 0), 0));
      addField('Total Borrowed Copies', books.reduce((sum, item) => sum + Math.max(0, (Number(item.total_copies) || 0) - (Number(item.available_copies) || 0)), 0));
      addBlankLine();

      books.forEach((item, index) => {
        addField(`BOOK ${index + 1}`);
        addField('ID', item.id);
        addField('Book Title', item.title);
        addField('Author', item.author);
        addField('Category', item.category);
        addField('Call Number', item.call_number || '');
        addField('Total Copies', item.total_copies);
        addField('Available Copies', item.available_copies);
        addField('Borrowed Copies', Math.max(0, (Number(item.total_copies) || 0) - (Number(item.available_copies) || 0)));
        addBlankLine();
      });
    } else if (inventoryTab === 'research') {
      filename += '-research';
      addField('LIBTRACK LIBRARY INVENTORY', 'RESEARCH MATERIALS');
      addField('Total Research Materials', researchItems.length);
      addField('With PDF File', researchItems.filter((item) => item.has_pdf).length);
      addBlankLine();

      researchItems.forEach((item, index) => {
        addField(`RESEARCH ${index + 1}`);
        addField('ID', item.id);
        addField('Title', item.title);
        addField('Author(s) / Researcher(s)', item.authors);
        addField('Research Teacher / Adviser', item.teacher || '');
        addField('Year', item.year);
        addField('Course', item.course);
        addField('Subject', item.subject);
        addField('Research Type', item.research_type || '');
        addField('Verification Status', item.verification_status || '');
        addField('PDF Available', item.has_pdf ? 'Yes' : 'No');
        addBlankLine();
      });
    } else {
      filename += '-ebooks';
      addField('LIBTRACK LIBRARY INVENTORY', 'E-BOOK FILES');
      addField('Total E-book Files', ebooks.length);
      addBlankLine();

      ebooks.forEach((item, index) => {
        addField(`E-BOOK ${index + 1}`);
        addField('ID', item.id);
        addField('Title', item.title);
        addField('Author', item.author);
        addField('Category', item.category);
        addField('Course', item.course || '');
        addField('Year', item.year || '');
        addField('Semester', item.semester || '');
        addField('Subject', item.subject || '');
        addField('File Name', item.file_name);
        addField('File Size', item.size || '');
        addField('Last Modified', item.modified_time || '');
        addBlankLine();
      });
    }

    // Use real BOM and CRLF characters so spreadsheet apps recognize UTF-8
    // correctly and place each field/value pair on a separate row.
    const csv = rows.map((row) => row.map(escapeCell).join(',')).join('\r\n');
    const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function deleteEbook(item: EBook) {
    if (!isAdmin || !token) return;
    if (!(await libtrackConfirm(`Are you sure you want to delete the e-book "${item.title}"? This will permanently remove its PDF file.`))) return;
    try {
      await readResponse(await fetch(`${API}/ebooks/${encodeURIComponent(item.id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }));
      if (selectedEbook?.id === item.id) setSelectedEbook(null);
      await loadEbooks();
      setNotice(`E-book "${item.title}" was deleted.`);
    } catch (err) {
      setEbooksError(`Could not delete e-book: ${getError(err)}`);
    }
  }

  function chooseEbookCover(item: EBook) {
    if (!isAdmin || !token) return;
    ebookCoverTargetRef.current = item.id;
    ebookCoverInputRef.current?.click();
  }

  async function uploadEbookCover(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    const id = ebookCoverTargetRef.current;
    if (!file || !id || !token) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setEbooksError('Cover must be JPG, PNG, or WEBP and no larger than 5 MB.');
      return;
    }
    setEbookCoverUploadingId(id);
    try {
      const body = new FormData(); body.append('file', file, file.name);
      await readResponse(await fetch(`${API}/ebooks/${encodeURIComponent(id)}/cover`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body,
      }));
      await loadEbooks();
      setNotice('E-book cover updated successfully.');
    } catch (err) {
      setEbooksError(`Could not update e-book cover: ${getError(err)}`);
    } finally {
      setEbookCoverUploadingId(null); ebookCoverTargetRef.current = null;
    }
  }

  async function uploadEbookPdf(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files || []);
    event.currentTarget.value = '';
    if (!files.length) return;
    if (!isAdmin || !token) { setEbooksError('Only admin accounts can upload e-books.'); return; }

    const invalid = files.find((file) => !file.name.toLowerCase().endsWith('.pdf') || (file.type && !['application/pdf', 'application/octet-stream'].includes(file.type)));
    if (invalid) { setEbooksError(`${invalid.name}: PDF files only. Please select .pdf files.`); return; }
    const oversized = files.find((file) => file.size > 50 * 1024 * 1024);
    if (oversized) { setEbooksError(`${oversized.name}: maximum PDF size is 50 MB per file.`); return; }

    setEbookUploading(true);
    setEbooksError('');
    let uploaded = 0;
    try {
      // Upload one at a time to avoid browser/backend memory spikes with large collections.
      for (const file of files) {
        const body = new FormData();
        body.append('file', file, file.name);
        body.append('category', ebookUploadCourse);
        body.append('course', ebookUploadCourse);
        body.append('year', ebookUploadYear);
        body.append('semester', ebookUploadSemester);
        body.append('subject', ebookUploadSubject.trim() || 'General');
        const response = await fetch(`${API}/ebooks`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body,
        });
        await readResponse(response);
        uploaded += 1;
      }
      await loadEbooks();
      setEbooksError('');
      setShowEbookUploadForm(false);
      await libtrackNotice('Upload Successful', `${uploaded} PDF file${uploaded === 1 ? '' : 's'} ${uploaded === 1 ? 'has' : 'have'} been added to the E-Book Library.`);
    } catch (err) {
      await loadEbooks();
      setEbooksError(`Uploaded ${uploaded} of ${files.length} PDFs. Upload stopped: ${getError(err)}`);
    } finally {
      setEbookUploading(false);
    }
  }

  async function importEbookZip(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (!isAdmin || !token) { setEbooksError('Only admin accounts can import e-books.'); return; }
    if (!file.name.toLowerCase().endsWith('.zip')) { setEbooksError('Please select a ZIP archive.'); return; }
    if (file.size > 1200 * 1024 * 1024) { setEbooksError('ZIP archive is too large. Maximum size is 1.2 GB.'); return; }

    setEbookUploading(true);
    setEbooksError('Uploading and importing ZIP archive. Keep this page open until it finishes.');
    try {
      const body = new FormData();
      body.append('file', file, file.name);
      const response = await fetch(`${API}/ebooks/import-zip`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body,
      });
      const result = await readResponse(response);
      await loadEbooks();
      setEbooksError('');
      await libtrackNotice('ZIP Import Complete', `Imported ${result.imported || 0} PDF file(s); skipped ${result.skipped || 0}.`);
    } catch (err) {
      setEbooksError(`Could not import ZIP: ${getError(err)}`);
      await loadEbooks();
    } finally {
      setEbookUploading(false);
    }
  }

  useEffect(() => {
    if (token) void loadEbooks();
  }, [token]);

  async function saveResearch(existing?: ResearchMaterial) {
    if (!isAdmin || !token) {
      setError('Only admin accounts can manage research.');
      return;
    }

    const form = await alertController.create({
      cssClass: 'libtrack-entry-form',
      header: existing ? 'Edit Research' : 'Add Research',
      message: 'Enter the research details below. Mark a record Verified only after checking the original source.',
      inputs: [
        { name: 'title', type: 'text', label: 'Research title', placeholder: 'Research or capstone title', value: existing?.title || '', attributes: { required: true } },
        { name: 'authors', type: 'text', label: 'Author(s) / Researcher(s)', placeholder: 'Author names', value: existing?.authors || '', attributes: { required: true } },
        { name: 'teacher', type: 'text', label: 'Research Teacher / Adviser', placeholder: 'Enter teacher or research adviser name', value: existing?.teacher || '' },
        { name: 'year', type: 'number', label: 'Year published', placeholder: 'e.g. 2025', value: existing?.year || '', attributes: { min: 1900, max: 2100 } },
        { name: 'course', type: 'text', label: 'Course', placeholder: 'BSIT, BSED, or BSBA', value: existing?.course || '', attributes: { required: true } },
        { name: 'research_type', type: 'text', label: 'Research type', placeholder: 'Research Paper / BSIT Capstone Project / Faculty Research', value: existing?.research_type || '', attributes: { required: true } },
        { name: 'subject', type: 'text', label: 'Subject / Category', placeholder: 'e.g. General, Information Technology', value: existing?.subject || '' },
        { name: 'abstract', type: 'textarea', label: 'Abstract / Summary', placeholder: 'Enter the actual abstract or a brief summary', value: existing?.abstract || '' },
        { name: 'url', type: 'url', label: 'Original source URL (optional)', placeholder: 'https://…', value: existing?.url || '' },
        { name: 'campus', type: 'text', label: 'Source campus / journal / publisher', placeholder: 'Source or institution', value: existing?.campus || '' },
        { name: 'verification_status', type: 'text', label: 'Verification status', placeholder: 'Unverified or Verified', value: existing?.verification_status || '' },
        { name: 'note', type: 'textarea', label: 'Research overview / note (optional)', placeholder: 'Additional notes', value: existing?.note || '' },
      ],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: existing ? 'Save Changes' : 'Add Research', role: 'confirm' },
      ],
    });
    await form.present();


    // Add a compact + button at the right edge of the Authors input.
    // Keep the extra inputs in this dialog and append their values on save.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const researchAlertRoot = form.shadowRoot || form;
    const researchAuthorInput = (
      researchAlertRoot.querySelector('input[name="authors"]') ||
      Array.from(researchAlertRoot.querySelectorAll('input.alert-input')).find((input) =>
        (input as HTMLInputElement).placeholder === 'Author names'
      )
    ) as HTMLInputElement | null;
    const researchAuthorExtras: HTMLInputElement[] = [];
    const researchAuthorWrapper = researchAuthorInput?.closest('.alert-input-wrapper') as HTMLElement | null;
    if (researchAuthorInput && researchAuthorWrapper) {
      const authorRow = document.createElement('div');
      authorRow.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;';
      researchAuthorWrapper.appendChild(authorRow);
      authorRow.appendChild(researchAuthorInput);
      researchAuthorInput.style.cssText += ';flex:1;min-width:0;width:100%;box-sizing:border-box;';

      const addResearchAuthor = document.createElement('button');
      addResearchAuthor.type = 'button';
      addResearchAuthor.textContent = '+';
      addResearchAuthor.title = 'Add another author';
      addResearchAuthor.setAttribute('aria-label', 'Add another author');
      addResearchAuthor.style.cssText = 'flex:0 0 42px;width:42px;height:44px;border:0;border-radius:10px;background:#54775b;color:#fff;font-size:25px;font-weight:700;line-height:1;cursor:pointer;';
      addResearchAuthor.addEventListener('click', () => {
        const extraRow = document.createElement('div');
        extraRow.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;margin-top:8px;';
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = `Author ${researchAuthorExtras.length + 2}`;
        input.setAttribute('aria-label', input.placeholder);
        input.style.cssText = 'flex:1;min-width:0;width:100%;box-sizing:border-box;min-height:44px;padding:10px 12px;border:1px solid #d7e0e8;border-radius:10px;background:#f8fafc;color:#203047;font-size:14px;';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '−';
        remove.title = 'Remove author';
        remove.setAttribute('aria-label', 'Remove author');
        remove.style.cssText = 'flex:0 0 42px;width:42px;height:44px;border:1px solid #d7e0e8;border-radius:10px;background:#f1f5f9;color:#475569;font-size:23px;cursor:pointer;';
        remove.addEventListener('click', () => {
          extraRow.remove();
          const index = researchAuthorExtras.indexOf(input);
          if (index >= 0) researchAuthorExtras.splice(index, 1);
        });
        extraRow.append(input, remove);
        researchAuthorWrapper.appendChild(extraRow);
        researchAuthorExtras.push(input);
        input.focus();
      });
      authorRow.appendChild(addResearchAuthor);
    }

    const result = await form.onDidDismiss();
    if (result.role !== 'confirm') return;

    const values = result.data?.values || {};
    const title = String(values.title || '').trim();
    const authors = [String(values.authors || '').trim(), ...researchAuthorExtras.map((input) => input.value.trim())].filter(Boolean).join(', ');
    const teacher = String(values.teacher || '').trim();
    const year = String(values.year || '').trim();
    const selectedCourse = String(values.course || 'BSIT').trim().toUpperCase();
    const researchType = String(values.research_type || 'Research Paper').trim();
    const subject = String(values.subject || 'General').trim();
    const abstract = String(values.abstract || '').trim();
    const url = String(values.url || '').trim();
    const campus = String(values.campus || 'NEUST Peñaranda Off-Campus').trim();
    const verificationStatus = String(values.verification_status || 'Unverified').trim();
    const note = String(values.note || '').trim();

    if (!title || !authors) {
      setError('Please enter the research title and author(s).');
      return;
    }
    if (!availableCourseOptions.some((courseOption) => courseOption.value.toUpperCase() === selectedCourse)) {
      setError('Please select or add a valid course first.');
      return;
    }
    if (url && !/^https?:\/\//i.test(url)) {
      setError('The source URL must start with http:// or https://.');
      return;
    }
    if (!['Verified', 'Unverified'].includes(verificationStatus)) {
      setError('Verification status must be Verified or Unverified.');
      return;
    }

    setLoading(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        title,
        authors,
        teacher: teacher || null,
        year: year || 'Not specified',
        course: selectedCourse,
        subject: subject || 'General',
        research_type: researchType || 'Research Paper',
        abstract: abstract || null,
        verification_status: verificationStatus,
        campus: campus || 'Source not specified',
        url,
        note: note || null,
      };
      const response = await fetch(existing ? `${API}/research/${existing.id}` : `${API}/research`, {
        method: existing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      const saved = await readResponse(response) as ResearchMaterial;
      if (!response.ok) throw new Error((saved as any)?.detail || 'Could not save research.');
      await loadResearch();
      setNotice(existing ? 'Research updated successfully.' : 'Research added successfully.');
    } catch (err) {
      setError(`Could not save research: ${getError(err)}`);
    } finally {
      setLoading(false);
    }
  }

  // Open the hidden PDF picker for the selected research record.
  function chooseResearchPdfUpload(item: ResearchMaterial) {
    if (!isAdmin || !token) {
      setError('Only admin accounts can upload research PDFs.');
      return;
    }

    uploadTargetResearchIdRef.current = item.id;
    setError('');
    setNotice('');
    researchPdfInputRef.current?.click();
  }

  async function uploadResearchPdf(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    const researchId = uploadTargetResearchIdRef.current;
    event.currentTarget.value = '';
    if (!file) return;
    if (!researchId) {
      setError('Select a research record before uploading a PDF.');
      return;
    }
    if (!isAdmin || !token) {
      setError('Only admin accounts can upload research PDFs.');
      return;
    }
    if (!file.name.toLowerCase().endsWith('.pdf') || (file.type && !['application/pdf', 'application/octet-stream'].includes(file.type))) {
      setError('Only PDF files can be uploaded. Choose a file with a .pdf extension.');
      return;
    }
    const maxBytes = 25 * 1024 * 1024;
    if (file.size > maxBytes) {
      setError('The PDF is too large. The maximum file size is 25 MB.');
      return;
    }
    if (file.size === 0) {
      setError('The selected PDF is empty.');
      return;
    }

    const item = researchItems.find((research) => research.id === researchId);
    setPdfUploadingResearchId(researchId);
    setError('');
    setNotice('');
    try {
      const body = new FormData();
      body.append('file', file, file.name);
      const response = await fetch(`${API}/research/${researchId}/pdf`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body,
      });
      const updated = await readResponse(response) as ResearchMaterial;
      setSelectedResearchCourse(getResearchCollectionKey(updated.course || item?.course || ''));
      await loadResearch();
      setSelectedResearchId(updated.id);
      setResearchView('reader');
      setNotice(`Uploaded the PDF for “${updated.title}”. It can now be read in the built-in reader.`);
    } catch (err) {
      setError(`Could not upload the research PDF: ${getError(err)}`);
    } finally {
      setPdfUploadingResearchId(null);
      uploadTargetResearchIdRef.current = null;
    }
  }

  async function deleteResearch(item: ResearchMaterial) {
    if (!isAdmin || !token || !await libtrackConfirm(`Are you sure you want to remove the research titled "${item.title}"?`)) return;
    try {
      await readResponse(await fetch(`${API}/research/${item.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }));
      setSelectedResearchId(null); setResearchView('course'); await loadResearch(); setNotice('Research record deleted.');
    } catch (err) { setError(`Could not delete research: ${getError(err)}`); }
  }

  async function chooseBookCover(bookId: number, bookTitle: string) {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/png,image/jpeg,image/webp';
    picker.onchange = async () => {
      const file = picker.files?.[0];
      if (!file) return;
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        setError('Please choose a JPG, PNG, or WEBP image.');
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        setError('Book cover image must be 5 MB or smaller.');
        return;
      }
      if (!token) {
        setError('Please log in as Admin before uploading a book cover.');
        return;
      }

      const formData = new FormData();
      formData.append('file', file);
      setSavingBook(true);
      setError('');
      try {
        const response = await fetch(`${API}/books/${bookId}/cover`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        });
        const updatedBook = await readResponse(response) as Book;
        setBooks((current) => current.map((item) => item.id === bookId ? updatedBook : item));
        setNotice(`Custom cover uploaded for “${bookTitle}”. It is now saved on the server and shared with other devices.`);
      } catch (err) {
        setError(`Could not upload book cover: ${getError(err)}`);
      } finally {
        setSavingBook(false);
      }
    };
    picker.click();
  }

  async function saveBook(existingBook?: Book) {

    if (!isAdmin) {
      setError('Only admin accounts can manage books.');
      return;
    }

    // Keep the book cover picker as the LAST native field in the Ionic form.
    // This places it directly below Total Copies and above the form buttons.
    let selectedCoverFile: File | null = null;

    const form = await alertController.create({
      cssClass: 'libtrack-entry-form',
      header: existingBook ? 'Edit Book' : 'Add Book',
      message: 'Fill in the book details below. Choose a JPG, PNG, or WEBP image for the book cover.',
      inputs: [
        { name: 'title', type: 'text', label: 'Book title', placeholder: 'Book title', value: existingBook?.title || '', attributes: { required: true } },
        { name: 'author', type: 'text', label: 'Author', placeholder: 'Author name', value: existingBook?.author || '', attributes: { required: true } },
        { name: 'category', type: 'text', label: 'Category', placeholder: 'e.g. Fiction, Science', value: existingBook ? cleanCategoryLabel(existingBook.category || '') : '', attributes: { required: true } },
        { name: 'call_number', type: 'text', label: 'Call number (optional)', placeholder: 'Call number', value: existingBook?.call_number || '' },
        { name: 'description', type: 'textarea', label: 'About this book', placeholder: 'Enter a description of the book', value: existingBook?.description ? existingBook.description.split(existingBook.category || '\u0000').join(cleanCategoryLabel(existingBook.category || '')) : (existingBook ? getBookAbout(existingBook) : '') },
        { name: 'total_copies', type: 'number', label: 'Total copies', placeholder: '1', value: String(existingBook?.total_copies ?? 1), attributes: { min: 1, step: 1, required: true } },
        // Keep this as the final input so the cover field is always at the bottom.
        { name: 'cover_file' as any, type: 'file' as any, label: 'Book Cover', attributes: { accept: 'image/png,image/jpeg,image/webp' } } as any,
      ],
      buttons: [
        { text: 'Cancel', role: 'cancel', cssClass: 'libtrack-dialog-cancel' },
        { text: existingBook ? 'Save Changes' : 'Add Book', role: 'confirm', cssClass: 'libtrack-dialog-confirm' },
      ],
    });

    await form.present();

    // Add a compact + button at the right edge of the Author input.
    // Keep the extra inputs in this dialog and append their values on save.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const bookAlertRoot = form.shadowRoot || form;
    const bookAuthorInput = (
      bookAlertRoot.querySelector('input[name="author"]') ||
      Array.from(bookAlertRoot.querySelectorAll('input.alert-input')).find((input) =>
        (input as HTMLInputElement).placeholder === 'Author name'
      )
    ) as HTMLInputElement | null;
    const bookAuthorExtras: HTMLInputElement[] = [];
    const bookAuthorWrapper = bookAuthorInput?.closest('.alert-input-wrapper') as HTMLElement | null;
    if (bookAuthorInput && bookAuthorWrapper) {
      const authorRow = document.createElement('div');
      authorRow.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;';
      bookAuthorWrapper.appendChild(authorRow);
      authorRow.appendChild(bookAuthorInput);
      bookAuthorInput.style.cssText += ';flex:1;min-width:0;width:100%;box-sizing:border-box;';

      const addBookAuthor = document.createElement('button');
      addBookAuthor.type = 'button';
      addBookAuthor.textContent = '+';
      addBookAuthor.title = 'Add another author';
      addBookAuthor.setAttribute('aria-label', 'Add another author');
      addBookAuthor.style.cssText = 'flex:0 0 42px;width:42px;height:44px;border:0;border-radius:10px;background:#54775b;color:#fff;font-size:25px;font-weight:700;line-height:1;cursor:pointer;';
      addBookAuthor.addEventListener('click', () => {
        const extraRow = document.createElement('div');
        extraRow.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;margin-top:8px;';
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = `Author ${bookAuthorExtras.length + 2}`;
        input.setAttribute('aria-label', input.placeholder);
        input.style.cssText = 'flex:1;min-width:0;width:100%;box-sizing:border-box;min-height:44px;padding:10px 12px;border:1px solid #d7e0e8;border-radius:10px;background:#f8fafc;color:#203047;font-size:14px;';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '−';
        remove.title = 'Remove author';
        remove.setAttribute('aria-label', 'Remove author');
        remove.style.cssText = 'flex:0 0 42px;width:42px;height:44px;border:1px solid #d7e0e8;border-radius:10px;background:#f1f5f9;color:#475569;font-size:23px;cursor:pointer;';
        remove.addEventListener('click', () => {
          extraRow.remove();
          const index = bookAuthorExtras.indexOf(input);
          if (index >= 0) bookAuthorExtras.splice(index, 1);
        });
        extraRow.append(input, remove);
        bookAuthorWrapper.appendChild(extraRow);
        bookAuthorExtras.push(input);
        input.focus();
      });
      authorRow.appendChild(addBookAuthor);
    }

    // Ionic AlertController renders its inputs inside the alert shadow root.
    // Attach the change handler after presentation so the selected File is
    // retained while the alert closes and the book is saved.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const alertRoot = form.shadowRoot || form;
    const coverInput = alertRoot.querySelector('input[type="file"]') as HTMLInputElement | null;

    if (coverInput) {
      coverInput.accept = 'image/png,image/jpeg,image/webp';
      coverInput.style.width = '100%';
      coverInput.style.maxWidth = '100%';
      coverInput.style.boxSizing = 'border-box';
      coverInput.style.padding = '10px';
      coverInput.style.border = '1px solid #d4deea';
      coverInput.style.borderRadius = '10px';
      coverInput.style.background = '#f7f9fc';

      // Live cover preview, placed immediately beneath the file picker.
      const preview = document.createElement('div');
      preview.style.cssText = 'margin-top:12px;padding:12px;border:1px solid #e1e7ee;border-radius:12px;background:#f8fafc;display:flex;flex-direction:column;align-items:center;gap:8px;';
      const previewLabel = document.createElement('div');
      previewLabel.textContent = 'Cover Preview';
      previewLabel.style.cssText = 'align-self:flex-start;font-size:12px;font-weight:700;color:#526174;';
      const previewImage = document.createElement('img');
      previewImage.alt = 'Selected book cover preview';
      previewImage.style.cssText = 'display:block;width:auto;max-width:100%;height:190px;object-fit:contain;border-radius:6px;background:#fff;';
      const previewEmpty = document.createElement('div');
      previewEmpty.textContent = 'Choose an image to see the cover preview';
      previewEmpty.style.cssText = 'font-size:12px;color:#8793a2;padding:22px 8px;text-align:center;';
      preview.append(previewLabel, previewImage, previewEmpty);
      coverInput.insertAdjacentElement('afterend', preview);

      let previewObjectUrl: string | null = null;
      const showPreview = (url: string | null) => {
        previewImage.hidden = !url;
        previewEmpty.hidden = !!url;
        if (url) previewImage.src = url;
        else previewImage.removeAttribute('src');
      };

      const currentCoverUrl = existingBook?.cover_image
        ? resolveBookImageUrl(existingBook.cover_image)
        : null;
      if (currentCoverUrl) showPreview(currentCoverUrl);
      else showPreview(null);

      coverInput.addEventListener('change', () => {
        const file = coverInput.files?.[0] || null;
        if (!file) {
          selectedCoverFile = null;
          showPreview(currentCoverUrl);
          return;
        }

        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
          selectedCoverFile = null;
          coverInput.value = '';
          showPreview(currentCoverUrl);
          setError('Please choose a JPG, PNG, or WEBP image.');
          return;
        }

        if (file.size > 5 * 1024 * 1024) {
          selectedCoverFile = null;
          coverInput.value = '';
          showPreview(currentCoverUrl);
          setError('Book cover image must be 5 MB or smaller.');
          return;
        }

        selectedCoverFile = file;
        if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
        previewObjectUrl = URL.createObjectURL(file);
        showPreview(previewObjectUrl);
        setError('');
        setNotice(`Selected book cover: ${file.name}. Press ${existingBook ? 'Save Changes' : 'Add Book'} to upload it.`);
      });

      form.addEventListener('ionAlertDidDismiss', () => {
        if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
      }, { once: true });
    } else {
      setError('The Book Cover field could not be initialized. Please refresh and try again.');
    }

    const result = await form.onDidDismiss();
    if (result.role !== 'confirm') return;

    const values = result.data?.values || {};
    const title = String(values.title || '').trim();
    const author = [String(values.author || '').trim(), ...bookAuthorExtras.map((input) => input.value.trim())]
      .filter(Boolean)
      .join(', ');
    const category = cleanCategoryLabel(String(values.category || '').trim());
    const call_number = String(values.call_number || '').trim();
    const description = String(values.description || '').trim();
    const total_copies = Number(values.total_copies);

    if (!title || !author || !category) {
      setError('Please enter the book title, author, and category.');
      return;
    }
    if (!Number.isInteger(total_copies) || total_copies < 1) {
      setError('Total copies must be a whole number greater than or equal to 1.');
      return;
    }

    setSavingBook(true);

    setError('');

    setNotice('');

    try {

      const response = await fetch(

        existingBook

          ? `${API}/books/${existingBook.id}`

          : `${API}/books`,

        {

          method: existingBook ? 'PATCH' : 'POST',

          headers: {

            'Content-Type': 'application/json',

            Authorization: `Bearer ${token}`,

          },

          body: JSON.stringify({

            title: title.trim(),

            author: author.trim(),

            category: category.trim(),

            call_number: call_number.trim() || null,

            description: description.trim() || null,

            total_copies,

          }),

        },

      );

      const savedBook = await readResponse(response) as Book;

      // Upload the selected cover immediately as part of this save workflow.
      if (selectedCoverFile && savedBook?.id) {
        const coverFormData = new FormData();
        coverFormData.append('file', selectedCoverFile);
        const coverResponse = await fetch(`${API}/books/${savedBook.id}/cover`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: coverFormData,
        });
        const bookWithCover = await readResponse(coverResponse) as Book;
        setBooks((current) => current.map((item) => item.id === bookWithCover.id ? bookWithCover : item));
      }

      setNotice(
        selectedCoverFile
          ? (existingBook ? 'Book and cover updated successfully.' : 'Book and cover added successfully.')
          : (existingBook ? 'Book updated successfully.' : 'Book added successfully.'),
      );

      setQuery('');

      setSelectedCategory('');

      // Reload catalog even if the query was already empty.

      const refreshResponse = await fetch(`${API}/books`, {

        headers: { Authorization: `Bearer ${token}` },

      });

      const refreshedBooks = await readResponse(refreshResponse);

      setBooks(Array.isArray(refreshedBooks) ? refreshedBooks : []);


    } catch (err) {

      setError(`Could not save book: ${getError(err)}`);

    } finally {

      setSavingBook(false);

    }

  }

  async function deleteBook(book: Book) {

    if (!isAdmin) return;

    if (!(await libtrackConfirm(`Are you sure you want to delete "${book.title}"?`))) {

      return;

    }

    setError('');

    setNotice('');

    try {

      const response = await fetch(`${API}/books/${book.id}`, {

        method: 'DELETE',

        headers: { Authorization: `Bearer ${token}` },

      });

      await readResponse(response);

      setNotice('Book deleted successfully.');

      setQuery('');

      setSelectedCategory('');

      const refreshResponse = await fetch(`${API}/books`, {

        headers: { Authorization: `Bearer ${token}` },

      });

      const refreshedBooks = await readResponse(refreshResponse);

      setBooks(Array.isArray(refreshedBooks) ? refreshedBooks : []);

    } catch (err) {

      setError(`Could not delete book: ${getError(err)}`);

    }

  }

  // ---------------------------------------------------------

  // DERIVED DATA

  // ---------------------------------------------------------

  // Merge similar legacy category labels for display and filtering only.
  // The original category values in libtrack_dev.db remain unchanged.
  const CATEGORY_GROUPS = [
    'Literature, Language and Filipino Studies',
    'Humanities and Social Sciences',
    'Education and Teaching',
    'Health and Physical Education',
    'Business and Economics',
    'Law, Government and Criminology',
    'Information Technology, Computer Science and Engineering',
    'Science, Mathematics and Technology',
    'Encyclopedias and Reference Materials',
  ];

  const canonicalBookCategory = (value: string, bookTitle = '') => {
    const label = cleanCategoryLabel(value || 'General');
    const normalized = label
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/&/g, ' and ');
    const title = String(bookTitle || '').toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[–—]/g, '-')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

    // Classify by the actual book title first. This corrects older/misfiled
    // database labels without changing any database records.
    const titleRules: Array<[RegExp, number]> = [
      // Teaching, education, teacher preparation, and LET review.
      [/\b(let questions|let review|teaching|teacher|education|educational|curriculum|classroom|pedagogy|learner|learning assessment|assessment in learning|assessment of student|special education|child development|developmental psychology|child rearing|childcare|child care|teaching internship|principles of teaching)\b/, 2],
      [/\b(technology for teaching|information skills for education|teaching mathematics|physical education handbook)\b/, 2],
      // Health, fitness, medicine, and allied-health materials.
      [/\b(health|medical|medicine|dental|anatomy|physiology|pregnancy|wellness|fitness|pathfit|physical activity|physical education|medical records)\b/, 3],
      // Law, justice, criminology, policing, and public safety.
      [/\b(law|legal|labor code|employment law|supreme court|criminology|criminal|penology|forensic|polygraph|police|victimology|restorative justice|human rights|corrections|juvenile delinquency|public safety|security management|evidence and criminal procedure)\b/, 5],
      // IT, computing, software, and engineering (including engineering titles).
      [/\b(computer|programming|programmer|software|database|networking|network|information technology|information systems|cybersecurity|cyber security|information assurance|web application|web programming|html5|css3|autocad|java|python|javascript|angularjs|mysql|ruby|scala|perl|engineering|machinery|fracture mechanics|multimodal imaging|electronic devices|electromagnetics|systems analysis|application development|windows|troubleshooting|data structures|artificial intelligence|fatigue testing and analysis|transportation)\b/, 6],
      // Business, finance, accounting, economics, tourism, and management.
      [/\b(business|accounting|accountancy|auditing|marketing|management|executive|finance|financial|taxation|economics|economic|macroeconomics|microeconomics|entrepreneurship|investment|investments|tourism|supply chain|logistics|operations management|production management|productivity|quality management|business mathematics|people s economy|fiscal administration|labor economics|political economy|annual report|development studies|regional integration)\b/, 4],
      // Reference works and periodicals.
      [/\b(encyclopedia|encyclopaedia|almanac|dictionary|thesaurus|reference volumes|reference books|national geographic magazine|the economist|annual editions series|bulletin|world almanac|ripley)\b/, 8],
      // Literature, languages, Filipino works, and literary criticism.
      [/\b(literature|literary|panitikan|filipino|wika|language|grammar|rhetoric|retorika|poetry|poem|novel|mythology|english|japanese|spanish|writing techniques|writing in|reading|balagtas|rizal|noli me tangere|el filibusterismo|ibong adarna|florante at laura|dekada|bata bata)\b/, 0],
      [/\b(sats?|scholastic aptitude|college entrance|entrance examination|test preparation|study guide|logic)\b/, 2],
      [/\b(science technology and society|general sociology|introduction to sociology|sociology|social research|political economy|philippine tourism)\b/, 1],
      [/\b(c the complete reference|c complete reference|c programming|c plus plus|c sharp)\b/, 6],
      // Mathematics and natural sciences (after computing/engineering and health).
      [/\b(mathematics|mathematical|calculus|algebra|statistics|physics|chemistry|biochemistry|biology|science|scientific|astronomy|universe|abstract algebra|discrete mathematics|transportation)\b/, 7],
      // History, geography, politics, culture, psychology, and social sciences.
      [/\b(history|historical|geography|geographic|political science|government|nation|asian|asia|philippine|philippines|china|korea|pakistan|bangladesh|culture|society|sociology|psychology|psychological|ethics|humanities|gender|self discovery|understanding the self|civic|social research|social science|world regional|world history|american history|american experience|people s history|development|public administration|anthropology|logic|ethics|values education|art appreciation|consuming passions|interracial|urban society|youth in today)\b/, 1],
    ];

    for (const [pattern, groupIndex] of titleRules) {
      if (pattern.test(` ${title} `)) return CATEGORY_GROUPS[groupIndex];
    }

    // If the title is not recognizable, use the existing category label.
    if (/humanit|psycholog|social science|history|kasaysayan|geography|political science|ekonomiks/.test(normalized)) return CATEGORY_GROUPS[1];
    if (/literature|language|filipino|panitikan|wika/.test(normalized)) return CATEGORY_GROUPS[0];
    if (/education|let review|pagtuturo|teaching/.test(normalized)) return CATEGORY_GROUPS[2];
    if (/physical education|health|medical|wellness|pathfit/.test(normalized)) return CATEGORY_GROUPS[3];
    if (/business|management|economics|finance|tourism|accounting|marketing/.test(normalized)) return CATEGORY_GROUPS[4];
    if (/law|labor|government|criminology|kriminolohiya|security|panseguridad/.test(normalized)) return CATEGORY_GROUPS[5];
    if (/information technology|computer science|engineering|programming|database|information systems/.test(normalized)) return CATEGORY_GROUPS[6];
    if (/science|agham|mathemat|technology|teknolohiya|calculus|physics|chemistry|biology/.test(normalized)) return CATEGORY_GROUPS[7];
    if (/encyclopedia|reference|dictionary|atlas|almanac|handbook/.test(normalized)) return CATEGORY_GROUPS[8];

    // Avoid a misleading catch-all. Unclassified academic/social titles go to
    // Humanities and Social Sciences until a more specific title rule exists.
    return CATEGORY_GROUPS[1];
  };

  // Category cards already receive canonical group names. Return those labels
  // unchanged so "Health and Physical Education" is not reclassified as
  // "Education and Teaching" merely because its name contains "Education".
  const displayCategoryName = (value: string, bookTitle = '') =>
    CATEGORY_GROUPS.includes(value) ? value : canonicalBookCategory(value, bookTitle);

  const categories = useMemo(
    () =>
      CATEGORY_GROUPS.filter((group) =>
        books.some((book) => canonicalBookCategory(book.category || 'General', book.title) === group),
      ),
    [books],
  );

  const filteredBooks = useMemo(
    () =>
      books.filter((book) => {
        if (!selectedCategory) return true;
        return canonicalBookCategory(book.category || 'General', book.title) === selectedCategory;
      }),
    [books, selectedCategory],
  );

  const totalCopies = books.reduce(

    (sum, book) => sum + (Number(book.total_copies) || 0),

    0,

  );

  const availableCopies = books.reduce(

    (sum, book) => sum + (Number(book.available_copies) || 0),

    0,

  );

  const unavailableTitles = books.filter(

    (book) => !book.available,

  ).length;

  // Admin Home insights are derived from the existing authenticated API data.
  const todayISO = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
  const adminPendingRequests = borrowings
    .filter((record) => record.status === 'pending')
    .sort((a, b) => String(b.borrowed_at || '').localeCompare(String(a.borrowed_at || '')))
    .slice(0, 5);
  const adminOverdueRecords = borrowings
    .filter((record) => record.status === 'borrowed' && record.due_date < todayISO)
    .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
  const adminLowStockBooks = books
    .filter((book) => Number(book.available_copies) <= 1)
    .sort((a, b) => Number(a.available_copies) - Number(b.available_copies))
    .slice(0, 6);
  const adminRecentActivities = [...borrowings]
    .filter((record) => ['pending', 'borrowed', 'returned'].includes(record.status))
    .sort((a, b) => String(b.returned_at || b.borrowed_at || '').localeCompare(String(a.returned_at || a.borrowed_at || '')))
    .slice(0, 6);
  const adminMonthlyBorrowing = (() => {
    const months: { key: string; label: string; count: number }[] = [];
    const now = new Date();
    for (let offset = 5; offset >= 0; offset -= 1) {
      const monthDate = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      const key = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}`;
      months.push({
        key,
        label: monthDate.toLocaleDateString('en-US', { month: 'short', timeZone: 'Asia/Manila' }),
        count: borrowings.filter((record) =>
          ['borrowed', 'returned'].includes(record.status)
          && String(record.borrowed_at || '').slice(0, 7) === key
        ).length,
      });
    }
    return months;
  })();
  const adminMaxMonthlyBorrowing = Math.max(1, ...adminMonthlyBorrowing.map((month) => month.count));
  const adminMostActiveCourses = (() => {
    const counts = new Map<string, number>();
    borrowings
      .filter((record) => ['borrowed', 'returned'].includes(record.status))
      .forEach((record) => {
        const borrower = accounts.find((account) => account.id === record.user_id);
        const course = String(borrower?.course || '').trim().toUpperCase();
        if (borrower?.role === 'student' && ['BSIT', 'BSBA', 'BSED'].includes(course)) {
          counts.set(course, (counts.get(course) || 0) + 1);
        }
      });
    return ['BSIT', 'BSBA', 'BSED']
      .map((course) => ({ course, count: counts.get(course) || 0 }))
      .sort((a, b) => b.count - a.count);
  })();

  const filteredAccounts = useMemo(() => {

    const search = accountQuery.trim().toLowerCase();

    return accounts.filter(

      (account) =>

        account.full_name.toLowerCase().includes(search) ||

        account.email.toLowerCase().includes(search) ||

        (account.student_id || '').toLowerCase().includes(search) ||

        (account.course || '').toLowerCase().includes(search) ||

        (account.year || '').toLowerCase().includes(search) ||

        (account.section || '').toLowerCase().includes(search) ||

        (account.username || '').toLowerCase().includes(search),

    );

  }, [accounts, accountQuery]);

  const accountCourseGroups = useMemo(() => {
    // Keep every account category available as a tab, even when it has no records.
    const groups = new Map<string, Account[]>([
      ['BSIT', []],
      ['BSED', []],
      ['BSBA', []],
      ['FACULTY ACCOUNTS', []],
      ['ADMIN ACCOUNTS', []],
    ]);
    for (const account of filteredAccounts) {
      const role = String(account.role || 'student').trim().toLowerCase();
      const course = account.course?.trim().toUpperCase();
      // Accounts without a course are omitted from the course tabs.
      if (role !== 'admin' && role !== 'faculty' && !course) continue;
      const group = role === 'admin'
        ? 'ADMIN ACCOUNTS'
        : role === 'faculty'
          ? 'FACULTY ACCOUNTS'
          : course!;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(account);
    }
    return [...groups.entries()].sort(([a], [b]) => {
      const order = ['BSIT', 'BSED', 'BSBA', 'FACULTY ACCOUNTS', 'ADMIN ACCOUNTS'];
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.localeCompare(b);
    });
  }, [filteredAccounts]);

  const visibleAccountGroup = accountCourseGroups.some(([name]) => name === selectedAccountGroup)
    ? selectedAccountGroup
    : (accountCourseGroups[0]?.[0] || selectedAccountGroup);
  const visibleAccountGroups = accountCourseGroups.filter(([name]) => name === visibleAccountGroup);

  async function deleteAccount(account: Account) {
    if (!isAdmin || !token) return;
    if (user && account.id === user.id) {
      setError('You cannot delete your own account while logged in.');
      setNotice('');
      return;
    }
    const confirmed = await libtrackConfirm(
      `Are you sure you want to delete the account for ${account.full_name} (${account.email})? This action cannot be undone. If the account has borrowing history, the API may reject the deletion.`
    );
    if (!confirmed) return;

    setDeletingAccountId(account.id);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`${API}/users/${account.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      await readResponse(response);
      setAccounts((current) => current.filter((item) => item.id !== account.id));
      setNotice(`Deleted the account for ${account.full_name}.`);
    } catch (err) {
      const detail = getError(err);
      setError(
        detail.includes('Request failed (409)')
          ? `Could not delete ${account.full_name} because the account has borrowing history. Keep the record or use the deactivation feature.`
          : `Could not delete the account for ${account.full_name}: ${detail}`
      );
    } finally {
      setDeletingAccountId(null);
    }
  }

  function editAccountDetails(account: Account) {
    if (!isAdmin || !token || String(account.role || '').toLowerCase() === 'admin') return;
    setError('');
    setNotice('');
    setEditingAccount(account);
    setAccountEditDraft({
      full_name: account.full_name || '',
      email: account.email || '',
      username: account.username || '',
      student_id: account.student_id || '',
      course: account.course || '',
      year: account.year || '',
      section: account.section || '',
      role: (account.role || 'student').toLowerCase(),
      active: !!account.active,
    });
  }

  async function saveAccountEdits() {
    if (!isAdmin || !token || !editingAccount || accountEditSaving) return;
    const draft = accountEditDraft;
    if (!draft.full_name.trim() || !draft.email.trim() || !draft.username.trim()) {
      setError('Full name, email, and username cannot be empty.');
      return;
    }
    setAccountEditSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`${API}/users/${editingAccount.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: draft.full_name.trim(),
          email: draft.email.trim(),
          username: draft.username.trim(),
          ...(String(editingAccount.role || '').toLowerCase() !== 'faculty' ? {
            student_id: draft.student_id.trim() || null,
            course: draft.course.trim() || null,
            year: draft.year.trim() || null,
            section: draft.section.trim() || null,
          } : {}),
        }),
      });
      const updated = await readResponse(response);
      setAccounts((current) => current.map((item) => item.id === editingAccount.id ? { ...item, ...updated } : item));
      if (user?.id === editingAccount.id) setUser((current) => current ? { ...current, ...updated } : current);
      setNotice(`Account details updated for ${updated.full_name || draft.full_name.trim()}.`);
      setEditingAccount(null);
    } catch (err) {
      setError(`Could not update account: ${getError(err)}`);
    } finally {
      setAccountEditSaving(false);
    }
  }

  function isAccountOnline(account: Account) {

    return (

      account.active &&

      loginSessions.some(

        (session) =>

          session.user_id === account.id &&

          session.status.toLowerCase() === 'online',

      )

    );

  }

  async function loadAdminProblemReports() {
    if (!token) return;
    setAdminProblemReportsLoading(true);
    setAdminProblemReportError('');
    try {
      const response = await fetch(`${API}/problem-reports`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await response.json().catch(() => []);
      if (!response.ok) throw new Error(data.detail || `Unable to load reports (${response.status}).`);
      setAdminProblemReports(Array.isArray(data) ? data : []);
    } catch (error) {
      setAdminProblemReportError(error instanceof Error ? error.message : 'Unable to load problem reports.');
    } finally {
      setAdminProblemReportsLoading(false);
    }
  }

  async function updateAdminProblemReport(reportId: number, status: string, adminNote = '') {
    try {
      const response = await fetch(`${API}/problem-reports/${reportId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status, admin_note: adminNote }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || `Unable to update report (${response.status}).`);
      await loadAdminProblemReports();
    } catch (error) {
      setAdminProblemReportError(error instanceof Error ? error.message : 'Unable to update report.');
    }
  }

  function navigate(nextPage: Page) {

    if (nextPage !== page) {
      pageHistoryRef.current.push(page);
      window.history.pushState({ libtrack: true, page: nextPage }, '', window.location.href);
    }
    setPage(nextPage);
    // Keep navigation behavior consistent for both student and admin sidebars.
    requestAnimationFrame(() => {
      void appContentRef.current?.scrollToTop(300);
    });
    if (nextPage === 'research') {
      setResearchView('collections');
      setSelectedResearchCourse('');
      setSelectedResearchId(null);
      setResearchQuery('');
    }

    setError('');

    setNotice('');

  }

  function navigateFromBottom(nextPage: Page) {
    navigate(nextPage);
    requestAnimationFrame(() => {
      void appContentRef.current?.scrollToTop(300);
    });
  }

  function navigateBack() {
    const previousPage = pageHistoryRef.current.pop();
    if (previousPage) {
      setPage(previousPage);
      if (previousPage === 'research') {
        setResearchView('collections');
        setSelectedResearchCourse('');
        setSelectedResearchId(null);
        setResearchQuery('');
      }
    } else {
      setPage('home');
    }
    setError('');
    setNotice('');
  }

  // ---------------------------------------------------------

  // LOGIN PAGE

  // ---------------------------------------------------------


  async function handleChangeAccountPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setChangePasswordMessage('');

    if (!token) {
      setChangePasswordMessage('Your session has expired. Please sign in again.');
      return;
    }
    if (!currentAccountPassword || !newAccountPassword || !confirmAccountPassword) {
      setChangePasswordMessage('Please fill in all three password fields.');
      return;
    }
    if (newAccountPassword.length < 10) {
      setChangePasswordMessage('New password must be at least 10 characters.');
      return;
    }
    if (newAccountPassword !== confirmAccountPassword) {
      setChangePasswordMessage('New password and confirmation do not match.');
      return;
    }
    if (currentAccountPassword === newAccountPassword) {
      setChangePasswordMessage('Choose a password different from your current password.');
      return;
    }

    setChangePasswordSaving(true);
    setChangePasswordMessage('Changing password...');
    try {
      const response = await fetch(`${API}/auth/change-password`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          current_password: currentAccountPassword,
          new_password: newAccountPassword,
        }),
      });
      await readResponse(response);
      setCurrentAccountPassword('');
      setNewAccountPassword('');
      setConfirmAccountPassword('');
      setShowCurrentAccountPassword(false);
      setShowNewAccountPassword(false);
      setShowConfirmAccountPassword(false);
      setChangePasswordMessage('Password changed successfully. Other devices have been signed out.');
    } catch (err) {
      setChangePasswordMessage(getError(err));
    } finally {
      setChangePasswordSaving(false);
    }
  }


  if (!token) {

    return (

      <IonApp>

        <IonContent fullscreen>

          <main className="auth-layout">

            <section className={`auth-panel ${isRegister ? 'register-panel' : 'login-panel'}`}>

              <div className="auth-heading">

                <div className="auth-icon" aria-label="LibTrack book logo">
                  <svg viewBox="0 0 48 48" aria-hidden="true">
                    <path
                      d="M10 13.5c5-2 9.5-1 14 2v20c-4.5-3-9-4-14-2z"
                      fill="#dbeafe"
                      stroke="#173b60"
                      strokeWidth="2.5"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M38 13.5c-5-2-9.5-1-14 2v20c4.5-3 9-4 14-2z"
                      fill="#bfdbfe"
                      stroke="#173b60"
                      strokeWidth="2.5"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M14 19l6 1.5M14 24l6 1.5M34 19l-6 1.5M34 24l-6 1.5"
                      stroke="#173b60"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>

                <p className="eyebrow">LIBTRACK ACCOUNT</p>

                <h2>{isRegister ? `Create your ${registerType} account` : 'Welcome back'}</h2>

                <p>{isRegister ? 'Register to access LibTrack using your own account.' : 'Sign in to access your library dashboard.'}</p>

              </div>

              <form onSubmit={handleAuth} className="auth-form">

                {isRegister && <>
                  <label className="register-field full-field">
                    <span>Account type</span>
                    <select className="auth-account-type" value={registerType} onChange={(event) => setRegisterType(event.target.value as 'student' | 'faculty')}>
                      <option value="student">Student</option>
                      <option value="faculty">Faculty</option>
                    </select>
                  </label>
                  <div className="register-field full-field profile-photo-field" style={{ display: 'grid', gridTemplateColumns: '64px minmax(0, 1fr)', alignItems: 'center', gap: 12, width: '100%', minWidth: 0, maxWidth: '100%', boxSizing: 'border-box', padding: 12, border: '1px dashed #b8c9dc', borderRadius: 14, background: '#f8fbff', overflow: 'hidden' }}>
                    <div style={{ width: 60, height: 60, borderRadius: '50%', overflow: 'hidden', display: 'grid', placeItems: 'center', background: '#eaf2ff', color: '#1765d1', fontSize: 24, fontWeight: 800 }}>
                      {signupPhotoPreview ? <img src={signupPhotoPreview} alt="Profile photo preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : (name.trim().charAt(0).toUpperCase() || '👤')}
                    </div>
                    <div style={{ minWidth: 0, width: '100%', overflow: 'hidden' }}>
                      <span style={{ display: 'block', fontWeight: 700, color: '#17324d', marginBottom: 5 }}>Profile photo</span>
                      <input type="file" accept="image/jpeg,image/png,image/webp" style={{ display: 'block', width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box', fontSize: 13 }} onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) { setError('Choose a JPG, PNG, or WEBP image up to 5 MB.'); event.target.value = ''; return; } setError(''); setSignupPhoto(file); setSignupPhotoPreview(URL.createObjectURL(file)); }} />
                    </div>
                  </div>



                  <label className="register-field full-field"><span>Full name</span><IonInput fill="outline" value={name} placeholder="Enter your full name" autocomplete="name" onIonInput={(e) => setName(String(e.detail.value ?? ''))} required minlength={2} maxlength={150} /></label>


                  {registerType === 'student' && <>
                  <div className="register-row">

                    <label className="register-field"><span>Student ID</span><IonInput fill="outline" value={studentId} placeholder="e.g. PEN-000001" onIonInput={(e) => setStudentId(String(e.detail.value ?? ''))} required maxlength={50} /></label>

                    <label className="register-field"><span>Course</span><IonSelect fill="outline" value={course} placeholder="Select your course" onIonChange={(e) => setCourse(String(e.detail.value ?? ''))} required interface="popover">{RESEARCH_COURSE_OPTIONS.map((courseOption) => <IonSelectOption key={courseOption.value} value={courseOption.value}>{courseOption.label}</IonSelectOption>)}</IonSelect></label>

                  </div>

                  <div className="register-row">

                    <label className="register-field"><span>Year</span><IonSelect fill="outline" value={year} placeholder="Select year" onIonChange={(e) => setYear(String(e.detail.value ?? ''))} required interface="popover"><IonSelectOption value="1st Year">1st Year</IonSelectOption><IonSelectOption value="2nd Year">2nd Year</IonSelectOption><IonSelectOption value="3rd Year">3rd Year</IonSelectOption><IonSelectOption value="4th Year">4th Year</IonSelectOption></IonSelect></label>

                    <label className="register-field"><span>Section</span><IonInput fill="outline" value={section} placeholder="e.g. A" onIonInput={(e) => setSection(String(e.detail.value ?? ''))} required maxlength={50} /></label>

                  </div>
                  </>}

                </>}

                <label className="register-field full-field"><span>Email address</span><IonInput fill="outline" type="email" value={email} placeholder="Enter your email" autocomplete="email" onIonInput={(e) => setEmail(String(e.detail.value ?? ''))} required /></label>

                {isRegister && <label className="register-field full-field"><span>Username</span><IonInput fill="outline" value={username} placeholder="Choose your username" autocomplete="username" onIonInput={(e) => setUsername(String(e.detail.value ?? ''))} required minlength={3} maxlength={50} /></label>}

                <label className="register-field full-field"><span>Password</span><div className="password-input-wrap"><IonInput fill="outline" type={showPassword ? 'text' : 'password'} value={password} placeholder={isRegister ? 'Create a secure password' : 'Enter your password'} autocomplete={isRegister ? 'new-password' : 'current-password'} onIonInput={(e) => setPassword(String(e.detail.value ?? ''))} required minlength={isRegister ? 10 : 1} maxlength={128} /><button type="button" className="password-toggle" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? 'HIDE' : 'SHOW'}</button></div></label>

                {!isRegister && <label className="remember-me-option"><input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} /><span>Remember me</span><small>Keep me signed in on this device</small></label>}

                {isRegister && <label className="register-field full-field"><span>Confirm password</span><div className="password-input-wrap"><IonInput fill="outline" type={showConfirmPassword ? 'text' : 'password'} value={confirmPassword} placeholder="Enter your password again" autocomplete="new-password" onIonInput={(e) => setConfirmPassword(String(e.detail.value ?? ''))} required minlength={10} maxlength={128} /><button type="button" className="password-toggle" onClick={() => setShowConfirmPassword((v) => !v)}>{showConfirmPassword ? 'HIDE' : 'SHOW'}</button></div></label>}

                {error && <IonText color="danger"><p className="form-message" role="alert">{error}</p></IonText>}

                {notice && <IonText color="success"><p className="form-message" role="status">{notice}</p></IonText>}

                <IonButton type="submit" expand="block" disabled={loading} className="gold-button">{loading ? <IonSpinner name="crescent" /> : isRegister ? 'Create Library Account →' : 'Sign In'}</IonButton>

              </form>

              <p className="switch-auth">{isRegister ? 'Already have an account?' : "Don't have an account yet?"}</p>

              <IonButton expand="block" fill="clear" className="switch-button" onClick={() => { setIsRegister(!isRegister); if (!isRegister) setRegisterType('student'); setError(''); setNotice(''); setShowPassword(false); setShowConfirmPassword(false); }}>

                {isRegister ? 'Sign in to LibTrack' : 'Create an account'}

              </IonButton>

            </section>

          </main>

        </IonContent>

      </IonApp>

    );

  }

  // ---------------------------------------------------------


  // Admin borrowing statistics loader
  useEffect(() => {
    if (!token || !isAdmin || page !== 'borrowingStats') return;
    let cancelled = false;
    const loadStats = async () => {
      setBorrowingStatsLoading(true);
      setBorrowingStatsError('');
      try {
        const response = await fetch(`${API}/reports/borrowing-statistics?academic_year=2026-2027`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await readResponse(response);
        if (!cancelled) setBorrowingStats(data);
      } catch (error: any) {
        if (!cancelled) setBorrowingStatsError(error?.message || 'Unable to load borrowing statistics.');
      } finally {
        if (!cancelled) setBorrowingStatsLoading(false);
      }
    };
    void loadStats();
    return () => { cancelled = true; };
  }, [token, isAdmin, page]);

  // MAIN APP

  // ---------------------------------------------------------

  if (userLoading && !user) {

    return (

      <IonApp>

        <IonContent fullscreen>

          <div className="loading-row">

            <IonSpinner name="crescent" />

            <span>Loading your account...</span>

          </div>

        </IonContent>

      </IonApp>

    );

  }

  return (

    <IonApp>

      <IonContent ref={appContentRef} fullscreen className="libtrack-app-content">

        <div className={`app-layout ${isAdmin ? 'admin-layout' : 'student-layout'}`}>

          {/* LEFT SIDEBAR */}

          <aside className="app-sidebar">

            <div className="sidebar-brand">

              <div className="brand-mark" aria-label="LibTrack book logo">
                <svg viewBox="0 0 48 48" width="42" height="42" aria-hidden="true">
                  <rect x="2" y="2" width="44" height="44" rx="13" fill="#ffffff" />
                  <path d="M10 13.5c5-2 9.5-1 14 2v20c-4.5-3-9-4-14-2z" fill="#dbeafe" stroke="#173b60" strokeWidth="2" strokeLinejoin="round" />
                  <path d="M38 13.5c-5-2-9.5-1-14 2v20c4.5-3 9-4 14-2z" fill="#bfdbfe" stroke="#173b60" strokeWidth="2" strokeLinejoin="round" />
                  <path d="M14 19l6 1.5M14 24l6 1.5M34 19l-6 1.5M34 24l-6 1.5" stroke="#173b60" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </div>

              <div>

                <strong>NEUST POC LibTrack</strong>

                <small>LIBRARY SYSTEM</small>

              </div>

            </div>

            <div className="sidebar-user">

              <button type="button" className="sidebar-avatar" aria-label="Preview profile photo" disabled={!user?.profile_photo_url} onClick={() => user?.profile_photo_url && setProfilePhotoPreview({ url: user.profile_photo_url, name: user.full_name || user.name || 'Profile photo' })} style={{ overflow: 'hidden', padding: 0, border: 0, cursor: user?.profile_photo_url ? 'zoom-in' : 'default' }}>
                {user?.profile_photo_url ? <img src={user.profile_photo_url} alt="Profile" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : (user?.full_name || user?.name || 'U').charAt(0).toUpperCase()}
              </button>

              <div className="sidebar-user-info">

                <strong>

                  {isAdmin
                    ? 'Library Administrator'
                    : user?.full_name || user?.name || 'Library User'}

                </strong>

                <small>{user?.role || 'student'}</small>

              </div>

            </div>

            <span className="sidebar-label">MAIN MENU</span>

            <nav className="sidebar-nav" aria-label="Main navigation">
              {isAdmin ? (
                <>
                  <button type="button" className={`sidebar-link ${page === 'home' ? 'selected' : ''}`} onClick={() => navigate('home')}>
                    <span>⌂</span> Home
                  </button>
                  <button type="button" className={`sidebar-link ${page === 'books' ? 'selected' : ''}`} onClick={() => navigate('books')}>
                    <span>▤</span> Book Catalog
                  </button>
                  <button type="button" className={`sidebar-link ${page === 'research' ? 'selected' : ''}`} onClick={() => navigate('research')}>
                    <span>▧</span> Research Library
                  </button>
                  <button type="button" className={`sidebar-link ${page === 'ebooks' ? 'selected' : ''}`} onClick={() => { setSelectedEbook(null); setEbookQuery(''); navigate('ebooks'); void loadEbooks(); }}>
                    <span>▣</span> E-Book Library
                  </button>
                  {isAdmin && <button type="button" className={`sidebar-link ${page === 'inventory' ? 'selected' : ''}`} onClick={() => { setInventoryQuery(''); navigate('inventory'); }}>
                    <span>▥</span> Inventory
                  </button>}
                  <button type="button" className={`sidebar-link ${page === 'borrowings' ? 'selected' : ''}`} onClick={() => navigate('borrowings')}>
                    <span>⇄</span> Borrowing Activity <span className="sidebar-count">{borrowings.length}</span>
                  </button>
                  <button type="button" className={`sidebar-link ${page === 'lostBooks' ? 'selected' : ''}`} onClick={() => navigate('lostBooks')}>
                    <span>⚠</span> Lost &amp; Damaged Books <span className="sidebar-count">{lostBookCases.filter((item) => item.resolution_status === 'unsettled').length}</span>
                  </button>
                  <button type="button" className={`sidebar-link ${page === 'accounts' ? 'selected' : ''}`} onClick={() => navigate('accounts')}>
                    <span>♙</span> All Accounts <span className="sidebar-count">{accounts.length}</span>
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className={`sidebar-link ${page === 'home' ? 'selected' : ''}`} onClick={() => navigate('home')}>
                    <span>⌂</span> Home
                  </button>
                  <button type="button" className={`sidebar-link ${page === 'research' ? 'selected' : ''}`} onClick={() => navigate('research')}>
                    <span>▧</span> Research Library
                  </button>
                  <button type="button" className={`sidebar-link ${page === 'ebooks' ? 'selected' : ''}`} onClick={() => { setSelectedEbook(null); setEbookQuery(''); navigate('ebooks'); void loadEbooks(); }}>
                    <span>▣</span> E-Books
                  </button>
                  <button type="button" className={`sidebar-link ${page === 'borrowings' ? 'selected' : ''}`} onClick={() => navigate('borrowings')}>
                    <span>◷</span> History <span className="sidebar-count">{borrowings.length}</span>
                  </button>
                </>
              )}
              <button type="button" className={`sidebar-link ${page === 'settings' ? 'selected' : ''}`} onClick={() => navigate('settings')}>
                <span>⚙</span> Settings
              </button>
            </nav>


          </aside>

          {/* MAIN CONTENT */}

          <div className="app-main">

            {page !== 'home' && (
              <header
                className="libtrack-topic-header"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px',
                  width: '100%',
                  boxSizing: 'border-box',
                  position: 'sticky',
                  top: 0,
                  zIndex: 1000,
                  padding: '16px 20px',
                  margin: '0 0 16px',
                  background: 'linear-gradient(110deg, #17283f 0%, #24445a 68%, #315a61 100%)',
                  color: '#ffffff',
                  borderBottom: '4px solid #e7c15b',
                  borderRadius: '0 0 16px 16px',
                }}
              >
                <div style={{ minWidth: 0, textAlign: 'left', marginRight: 'auto' }}>
                  <div style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.14em', color: '#f8c94e', marginBottom: '4px' }}>
                    NEUST LIBTRACK
                  </div>
                  <h1 style={{ margin: 0, fontSize: 'clamp(20px, 4vw, 27px)', lineHeight: 1.2, fontWeight: 800 }}>
                    {({
                      categories: 'Book Categories',
                      books: 'Book Catalog',
                      research: 'Research Library',
                      ebooks: 'E-Book Library',
                      inventory: 'Library Inventory',
                      borrowings: isAdmin ? 'Borrowing Activity' : 'My Borrowing History',
                      lostBooks: 'Lost & Damaged Books',
                      accounts: 'All Accounts',
                      sessions: 'Logged-in Accounts',
                      profile: 'My Profile',
                      settings: 'Settings',
                    } as Record<string, string>)[page] || 'LibTrack'}
                  </h1>
                </div>
                <img
                  src="/images/poc.png"
                  alt="NEUST Peñaranda Off-Campus logo"
                  style={{ width: '48px', height: '48px', objectFit: 'contain', flexShrink: 0, borderRadius: '8px' }}
                />

              </header>
            )}

            {page === 'home' && (
            <header className="app-topbar">

              <div className="topbar-brand" aria-label="LibTrack library logo">
                <div className="topbar-brand-mark" aria-hidden="true">
                  <svg viewBox="0 0 48 48" role="img" focusable="false">
                    <rect x="2" y="2" width="44" height="44" rx="13" fill="#ffffff"/>
                    <path d="M10 13.5c5-2 9.5-1 14 2v20c-4.5-3-9-4-14-2z" fill="#dbeafe" stroke="#173b60" strokeWidth="2" strokeLinejoin="round"/>
                    <path d="M38 13.5c-5-2-9.5-1-14 2v20c4.5-3 9-4 14-2z" fill="#bfdbfe" stroke="#173b60" strokeWidth="2" strokeLinejoin="round"/>
                    <path d="M14 19l6 1.5M14 24l6 1.5M34 19l-6 1.5M34 24l-6 1.5" stroke="#173b60" strokeWidth="1.6" strokeLinecap="round"/>
                  </svg>
                </div>
                <div className="topbar-brand-copy"><strong>LibTrack</strong><small>NEUST Peñaranda Off-Campus</small><small>Library Management System</small></div>
              </div>

              <img
                className="topbar-school-logo"
                src="/images/neust-poc-logo.png"
                alt="NEUST school logo"
              />

              {/* Desktop page title removed to match the compact mobile header. */}
              <div className="topbar-action-stack">
              <div className="topbar-actions">
                <div className="due-notification-wrap">
                  <button className="topbar-notification" type="button" aria-label="Notifications" title="Notifications" aria-expanded={showDueNotifications} onClick={() => { setShowDueNotifications((open) => !open); if (!isAdmin) void loadStudentNotifications(); }}><IonIcon icon={notificationsOutline} aria-hidden="true" />{((!isAdmin ? studentNotifications.filter((item) => !item.is_read).length : 0) + borrowings.filter((item) => !item.returned_at && item.status.toLowerCase() === 'borrowed' && item.due_date).length) > 0 && <span className="notification-dot">{(!isAdmin ? studentNotifications.filter((item) => !item.is_read).length : 0) + borrowings.filter((item) => !item.returned_at && item.status.toLowerCase() === 'borrowed' && item.due_date).length}</span>}</button>
                  {showDueNotifications && <div className="due-notification-panel" role="dialog" aria-label="Book due date notifications">
                    <div className="due-notification-heading"><strong>Notifications</strong><button type="button" aria-label="Close notifications" onClick={() => setShowDueNotifications(false)}>×</button></div>
                    {!isAdmin && <div className="due-notification-list">
                      {studentNotificationsLoading && <p className="due-notification-empty">Loading notifications...</p>}
                      {!studentNotificationsLoading && studentNotifications.length === 0 && <p className="due-notification-empty">No library updates yet.</p>}
                      {studentNotifications.map((item) => <button type="button" className={`due-notification-item ${item.is_read ? '' : 'is-soon'}`} key={`notice-${item.id}`} onClick={() => void markStudentNotificationRead(item.id)}>
                        <span className="due-notification-book">{item.title}</span>
                        <small style={{ whiteSpace:'normal', lineHeight:1.45 }}>{item.message}</small>
                        <span className="due-notification-date">{item.created_at ? new Date(item.created_at).toLocaleString() : ''}{!item.is_read ? ' • NEW' : ''}</span>
                      </button>)}
                    </div>}
                    <div className="due-notification-heading" style={{ borderTop:'1px solid #e5eaf0', marginTop:8, paddingTop:10 }}><strong>Book Due Dates</strong></div>
                    {borrowings.filter((item) => !item.returned_at && item.status.toLowerCase() === 'borrowed' && item.due_date).length === 0 ? <p className="due-notification-empty">No upcoming book due dates.</p> : <div className="due-notification-list">
                      {borrowings.filter((item) => !item.returned_at && item.status.toLowerCase() === 'borrowed' && item.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date)).map((item) => { const due = new Date(`${item.due_date}T00:00:00`); const today = new Date(); today.setHours(0,0,0,0); const days = Math.round((due.getTime() - today.getTime()) / 86400000); const book = books.find((entry) => entry.id === item.book_id); return <button type="button" className={`due-notification-item ${days < 0 ? 'is-overdue' : days <= 2 ? 'is-soon' : ''}`} key={item.id} onClick={() => { setShowDueNotifications(false); navigate('borrowings'); }}><span className="due-notification-book">{book?.title || `Book #${item.book_id}`}</span><span className="due-notification-date">Due: {item.due_date}</span><small>{days < 0 ? `${Math.abs(days)} day(s) overdue` : days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : `Due in ${days} days`}</small></button>; })}
                    </div>}
                  </div>}
                </div>
                <button className="topbar-account" type="button" title="Open profile" aria-label="Open user profile" onClick={() => { setShowDueNotifications(false); navigate('profile'); }}>
                  <span className="user-dot" style={{ overflow: 'hidden', padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 38px' }}>
                    {user?.profile_photo_url ? (
                      <img src={user.profile_photo_url} alt="Profile" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
                    ) : (
                      (user?.full_name || user?.name || user?.email || 'U').trim().charAt(0).toUpperCase()
                    )}
                  </span>
                  <span className="topbar-user-copy"><strong>{(user?.full_name || user?.name || user?.email || 'Library User').split(' ')[0]}</strong><small>{isAdmin ? 'Administrator' : isFaculty ? 'Faculty' : 'Student'}</small></span>
                  {isAdmin && <IonBadge color="warning">ADMIN</IonBadge>}
                </button>
              </div>
                <button type="button" className="topbar-logout" onClick={() => void confirmLogout()}>
                  <span className="topbar-logout-icon" aria-hidden="true">⇥</span> Log Out
                </button>
              </div>

            </header>
            )}

            <main className="app-page">

              {error && (

                <IonText color="danger">

                  <p className="form-message" role="alert">

                    {error}

                  </p>

                </IonText>

              )}

              {notice && (

                <IonText color="success">

                  <p className="form-message" role="status">

                    {notice}

                  </p>

                </IonText>

              )}

              {/* SETTINGS */}
              {page === 'settings' && (
                <section className="settings-page">
                  {!isAdmin && (
                    <>
                      <section className="settings-account-overview">
                        <div className="settings-avatar" style={{ overflow:'hidden', padding:0, display:'grid', placeItems:'center' }}>
                          {user?.profile_photo_url ? (
                            <img src={user.profile_photo_url} alt="Profile photo" style={{ width:'100%', height:'100%', objectFit:'cover', display:'block' }} />
                          ) : (
                            (user?.full_name || user?.name || user?.email || 'U').trim().charAt(0).toUpperCase()
                          )}
                        </div>
                        <div className="settings-account-info">
                          <span className="settings-kicker">SIGNED IN ACCOUNT</span>
                          <h3>{user?.full_name || user?.name || 'Library User'}</h3>
                          <p>{user?.email || 'No email provided'}</p>
                          <div className="settings-account-tags">
                            <span className="settings-role">{accountRoleLabel} ACCOUNT</span>
                            {isStudent && user?.course && <span>{user.course}</span>}
                            {isStudent && user?.year && <span>{user.year}{user?.section ? ` · ${user.section}` : ''}</span>}
                          </div>
                        </div>
                        <IonButton className="settings-profile-button" onClick={() => navigate('profile')}>View Profile</IonButton>
                      </section>

                      <div className="settings-section-title">
                        <div><span>{isFaculty ? 'FACULTY ACCOUNT' : 'STUDENT ACCOUNT'}</span><h3>Account & Support</h3></div>
                        <p>Choose an option to open its own page.</p>
                      </div>
                      <div className="settings-shortcut-grid">
                        <button className="settings-shortcut" onClick={() => navigate('profile')}>
                          <span className="settings-shortcut-icon">👤</span><span><strong>Profile Information</strong><small>View and update your personal details</small></span><b>›</b>
                        </button>
                        <button className="settings-shortcut" onClick={() => navigate('user-password')}>
                          <span className="settings-shortcut-icon">🔑</span><span><strong>Change Password</strong><small>Update your account password securely</small></span><b>›</b>
                        </button>
                        <button className="settings-shortcut" onClick={() => navigate('user-guidelines')}>
                          <span className="settings-shortcut-icon">📚</span><span><strong>Library Guidelines</strong><small>Borrowing rules and library reminders</small></span><b>›</b>
                        </button>
                        <button className="settings-shortcut" onClick={() => navigate('user-library-schedule')}>
                          <span className="settings-shortcut-icon">🗓️</span><span><strong>Library Schedule</strong><small>Opening hours, closed days, and holidays</small></span><b>›</b>
                        </button>
                        <button className="settings-shortcut" onClick={() => navigate('user-requests')}>
                          <span className="settings-shortcut-icon">📋</span><span><strong>My Requests</strong><small>Track your borrowing requests and status</small></span><b>›</b>
                        </button>
                        <button className="settings-shortcut" onClick={() => navigate('user-saved-books')}>
                          <span className="settings-shortcut-icon">🔖</span><span><strong>Saved Books</strong><small>Keep a personal list of books to revisit</small></span><b>›</b>
                        </button>
                        <button className="settings-shortcut" onClick={() => { navigate('user-notifications'); void loadStudentNotifications(); }}>
                          <span className="settings-shortcut-icon">🔔</span><span><strong>Notification History</strong><small>Open and read your library notifications</small></span><b>›</b>
                        </button>
                        <button className="settings-shortcut" onClick={() => navigate('user-preferences')}>
                          <span className="settings-shortcut-icon">⚙️</span><span><strong>App Preferences</strong><small>Choose which updates you want to see</small></span><b>›</b>
                        </button>
                        <button className="settings-shortcut" onClick={() => navigate('user-about')}>
                          <span className="settings-shortcut-icon">ℹ️</span><span><strong>About LibTrack</strong><small>Learn about the library portal</small></span><b>›</b>
                        </button>
                        <button className="settings-shortcut" onClick={() => navigate('user-support')}>
                          <span className="settings-shortcut-icon">❓</span><span><strong>Help &amp; Support</strong><small>FAQs and help using LibTrack</small></span><b>›</b>
                        </button>
                        <button className="settings-shortcut" onClick={() => { setProblemDescription(''); setProblemReportMessage(''); navigate('user-report'); }}>
                          <span className="settings-shortcut-icon">💬</span><span><strong>Report a Problem</strong><small>Describe an account or app issue</small></span><b>›</b>
                        </button>
                        <button className="settings-shortcut" onClick={() => navigate('user-privacy')}>
                          <span className="settings-shortcut-icon">🛡️</span><span><strong>Privacy &amp; Security</strong><small>Account safety and privacy guidance</small></span><b>›</b>
                        </button>
                        <button className="settings-shortcut danger" onClick={() => void confirmLogout()}>
                          <span className="settings-shortcut-icon">🚪</span><span><strong>Log Out</strong><small>End your LibTrack session securely</small></span><b>›</b>
                        </button>
                      </div>

                    </>
                  )}
                  {isAdmin && (
                    <section className="settings-admin-panel" style={{ padding:0, border:0, background:'transparent', boxShadow:'none' }}>
                      <div className="settings-section-title settings-admin-links-title" style={{ marginTop:22 }}>
                        <div><span>ADMINISTRATOR ONLY</span><h3>Manage LibTrack</h3></div>
                        
                      </div>
                      <div className="settings-shortcut-grid admin-shortcuts">
                        <button className="settings-shortcut" onClick={() => navigate('profile')}><span className="settings-shortcut-icon">👤</span><span><strong>Admin Profile</strong><small>View your administrator account</small></span><b>›</b></button>
                        <button className="settings-shortcut" onClick={() => navigate('admin-password')}><span className="settings-shortcut-icon">🔐</span><span><strong>Change Password</strong><small>Update your account password</small></span><b>›</b></button>
                        <button className="settings-shortcut" onClick={() => navigate('accounts')}><span className="settings-shortcut-icon">♙</span><span><strong>All Accounts</strong><small>View student and administrator accounts</small></span><b>›</b></button>
                        <button className="settings-shortcut" onClick={() => navigate('sessions')}><span className="settings-shortcut-icon">◉</span><span><strong>Logged-in Accounts</strong><small>Review active login sessions</small></span><b>›</b></button>
                        <button className="settings-shortcut" onClick={() => navigate('admin-library-schedule')}><span className="settings-shortcut-icon">🕒</span><span><strong>Library Schedule</strong><small>Set daily library opening hours</small></span><b>›</b></button>
                        <button className="settings-shortcut" onClick={() => navigate('admin-borrowing-schedule')}><span className="settings-shortcut-icon">📚</span><span><strong>Borrowing Schedule</strong><small>Set borrowing days and hours</small></span><b>›</b></button>
                        <button className="settings-shortcut" onClick={() => navigate('admin-weekend-notice')}><span className="settings-shortcut-icon">🔔</span><span><strong>Weekend Notice</strong><small>Configure student pop-up reminders</small></span><b>›</b></button>
                        <button className="settings-shortcut" onClick={() => { setInventoryQuery(''); navigate('inventory'); }}><span className="settings-shortcut-icon">▥</span><span><strong>Library Inventory</strong><small>Books, research, and e-books</small></span><b>›</b></button>
                        <button className="settings-shortcut" onClick={() => navigate('research')}><span className="settings-shortcut-icon">🗂️</span><span><strong>Research Courses</strong><small>Manage research materials</small></span><b>›</b></button>
                        <button className="settings-shortcut" onClick={() => { setSelectedEbook(null); setEbookQuery(''); navigate('ebooks'); void loadEbooks(); }}><span className="settings-shortcut-icon">📘</span><span><strong>E-Book Collections</strong><small>Manage digital collections</small></span><b>›</b></button>
                        <button className="settings-shortcut" onClick={() => navigate('borrowings')}><span className="settings-shortcut-icon">⇄</span><span><strong>Borrowing Activity</strong><small>Review all book borrowing records</small></span><b>›</b></button>
                        <button className="settings-shortcut" onClick={() => navigate('borrowingStats')}><span className="settings-shortcut-icon">▤</span><span><strong>Borrowing Statistics</strong><small>View borrowing reports and summaries</small></span><b>›</b></button>
                        <button className="settings-shortcut" onClick={() => navigate('lostBooks')}><span className="settings-shortcut-icon">⚠</span><span><strong>Lost &amp; Damaged Books</strong><small>Review lost and damaged book cases</small></span><b>›</b></button>
                        <button className="settings-shortcut" onClick={() => { navigate('admin-problem-reports'); void loadAdminProblemReports(); }}><span className="settings-shortcut-icon">💬</span><span><strong>Problem Reports</strong><small>Review student and faculty reports</small></span><b>›</b></button>
                        <button className="settings-shortcut danger" onClick={() => void confirmLogout()}><span className="settings-shortcut-icon">🚪</span><span><strong>Log Out</strong><small>End this admin session</small></span><b>›</b></button>
                      </div>
                    </section>
                  )}
                  {!isAdmin && <div className="settings-footer-note"><span>🛡️</span><p>Your account information is managed by the LibTrack administrator. If any registered detail is incorrect, please contact your library administrator.</p></div>}
                </section>
              )}


              {/* STUDENT AND FACULTY SETTINGS: SEPARATE PAGES */}
              {!isAdmin && page === 'user-password' && (
                <section className="settings-page">
                  <button type="button" className="settings-shortcut" onClick={navigateBack}><b>‹</b><span><strong>Back to Settings</strong><small>Return to Account & Support</small></span></button>
                  <div className="settings-section-title"><div><span>ACCOUNT SECURITY</span><h3>Change Password</h3></div><p>Update your password securely. Use a password you have not used before.</p></div>
                                    <article className="settings-card" style={{ width:'100%' }}>
                    <form onSubmit={(event) => void handleChangeAccountPassword(event)} style={{ display:'grid', gap:12 }}>
                      <label className="settings-field">Current Password
                        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                          <input type={showCurrentAccountPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="Enter current password" value={currentAccountPassword} onChange={(event) => { setCurrentAccountPassword(event.target.value); setChangePasswordMessage(''); }} required style={{ flex:1, minWidth:0 }} />
                          <button type="button" onClick={() => setShowCurrentAccountPassword((value) => !value)}>{showCurrentAccountPassword ? 'Hide' : 'Show'}</button>
                        </div>
                      </label>
                      <label className="settings-field">New Password <small>At least 10 characters.</small>
                        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                          <input type={showNewAccountPassword ? 'text' : 'password'} autoComplete="new-password" minLength={10} placeholder="Enter new password" value={newAccountPassword} onChange={(event) => { setNewAccountPassword(event.target.value); setChangePasswordMessage(''); }} required style={{ flex:1, minWidth:0 }} />
                          <button type="button" onClick={() => setShowNewAccountPassword((value) => !value)}>{showNewAccountPassword ? 'Hide' : 'Show'}</button>
                        </div>
                      </label>
                      <label className="settings-field">Confirm New Password
                        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                          <input type={showConfirmAccountPassword ? 'text' : 'password'} autoComplete="new-password" minLength={10} placeholder="Confirm new password" value={confirmAccountPassword} onChange={(event) => { setConfirmAccountPassword(event.target.value); setChangePasswordMessage(''); }} required style={{ flex:1, minWidth:0 }} />
                          <button type="button" onClick={() => setShowConfirmAccountPassword((value) => !value)}>{showConfirmAccountPassword ? 'Hide' : 'Show'}</button>
                        </div>
                      </label>
                      <IonButton type="submit" expand="block" disabled={changePasswordSaving}>{changePasswordSaving ? 'Saving Password...' : 'Save New Password'}</IonButton>
                      {changePasswordMessage && <p role="status" aria-live="polite">{changePasswordMessage}</p>}
                    </form>
                  </article>
                </section>
              )}
              {!isAdmin && page === 'user-notifications' && (
                <section className="settings-page">
                  <button type="button" className="settings-shortcut" onClick={navigateBack}><b>‹</b><span><strong>Back to Settings</strong><small>Return to Account & Support</small></span></button>
                  <div className="settings-section-title">
                    <div><span>LIBRARY UPDATES</span><h3>Notification History</h3></div>
                    <p>Tap any notification to open and read its full message.</p>
                  </div>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:10, marginBottom:12 }}>
                    <span style={{ color:'#73849a', fontSize:13 }}>{studentNotifications.length} notification(s)</span>
                    <IonButton size="small" fill="outline" onClick={() => void loadStudentNotifications()} disabled={studentNotificationsLoading}>
                      {studentNotificationsLoading ? 'Refreshing...' : 'Refresh'}
                    </IonButton>
                  </div>
                  {studentNotificationsLoading && studentNotifications.length === 0 && (
                    <article className="settings-card"><p>Loading your notification history...</p></article>
                  )}
                  {!studentNotificationsLoading && studentNotifications.length === 0 && (
                    <article className="settings-card" style={{ textAlign:'center', padding:28 }}>
                      <div style={{ fontSize:34, marginBottom:8 }}>🔔</div>
                      <h3 style={{ margin:'0 0 6px' }}>No notifications yet</h3>
                      <p style={{ margin:0, color:'#7b8ba0' }}>Library announcements and account updates will appear here.</p>
                    </article>
                  )}
                  <div style={{ display:'grid', gap:11 }}>
                    {studentNotifications.map((item) => (
                      <button
                        key={`history-${item.id}`}
                        type="button"
                        onClick={() => {
                          setSelectedStudentNotification(item);
                          if (!item.is_read) void markStudentNotificationRead(item.id);
                        }}
                        style={{
                          width:'100%', textAlign:'left', display:'grid', gridTemplateColumns:'44px minmax(0,1fr) 20px',
                          alignItems:'center', gap:12, padding:14, borderRadius:15,
                          border:item.is_read ? '1px solid #e1e8f0' : '1px solid #e9c96e',
                          background:item.is_read ? '#fff' : '#fffaf0', color:'#193550',
                          boxShadow:'0 3px 12px rgba(25,53,80,.045)', cursor:'pointer'
                        }}
                      >
                        <span style={{ width:42, height:42, borderRadius:12, display:'grid', placeItems:'center', background:item.is_read ? '#eef3f8' : '#fff1c9', fontSize:20 }}>
                          {item.notification_type === 'lost_damaged_book' ? '⚠️' : item.notification_type.toLowerCase().includes('borrow') ? '📚' : '🔔'}
                        </span>
                        <span style={{ minWidth:0, display:'grid', gap:4 }}>
                          <strong style={{ fontSize:14, lineHeight:1.35 }}>{item.title || 'Library Notification'}</strong>
                          <span style={{ fontSize:12, color:'#718198', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{item.message}</span>
                          <span style={{ fontSize:11, color:'#8a98aa' }}>{item.created_at ? new Date(item.created_at).toLocaleString() : 'Date unavailable'}{!item.is_read ? ' · NEW' : ' · READ'}</span>
                        </span>
                        {!item.is_read && <span aria-label="Unread" style={{ width:9, height:9, borderRadius:'50%', background:'#d49b19', justifySelf:'center' }} />}
                        {item.is_read && <span style={{ color:'#9aa8b8', fontSize:18, justifySelf:'center' }}>›</span>}
                      </button>
                    ))}
                  </div>
                  {selectedStudentNotification && (
                    <div
                      role="presentation"
                      onClick={() => setSelectedStudentNotification(null)}
                      style={{ position:'fixed', inset:0, zIndex:16000, display:'grid', placeItems:'center', padding:18, background:'rgba(10,28,48,.62)', backdropFilter:'blur(4px)' }}
                    >
                      <section
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="notification-detail-title"
                        onClick={(event) => event.stopPropagation()}
                        style={{ width:'min(100%, 460px)', maxHeight:'min(82vh, 680px)', overflowY:'auto', background:'#fff', color:'#193550', borderRadius:20, padding:22, boxShadow:'0 24px 70px rgba(10,30,52,.3)' }}
                      >
                        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:12 }}>
                          <span style={{ width:48, height:48, borderRadius:14, background:'#fff4d7', display:'grid', placeItems:'center', fontSize:23 }}>
                            {selectedStudentNotification.notification_type === 'lost_damaged_book' ? '⚠️' : selectedStudentNotification.notification_type.toLowerCase().includes('borrow') ? '📚' : '🔔'}
                          </span>
                          <button type="button" aria-label="Close notification" onClick={() => setSelectedStudentNotification(null)} style={{ border:0, borderRadius:9, width:36, height:36, background:'#eef2f7', color:'#243b55', fontSize:22, cursor:'pointer' }}>×</button>
                        </div>
                        <span style={{ display:'block', marginTop:16, color:'#b18425', fontSize:10, fontWeight:850, letterSpacing:'.13em' }}>LIBTRACK NOTIFICATION</span>
                        <h3 id="notification-detail-title" style={{ margin:'7px 0 8px', fontSize:21, lineHeight:1.3 }}>{selectedStudentNotification.title || 'Library Notification'}</h3>
                        <p style={{ margin:'0 0 16px', color:'#7b8ba0', fontSize:12 }}>{selectedStudentNotification.created_at ? new Date(selectedStudentNotification.created_at).toLocaleString() : 'Date unavailable'}</p>
                        <div style={{ padding:16, borderRadius:13, background:'#f5f8fc', color:'#40566f', lineHeight:1.65, fontSize:14, whiteSpace:'pre-wrap', overflowWrap:'anywhere' }}>
                          {selectedStudentNotification.message || 'No additional message was provided.'}
                        </div>
                        <div style={{ marginTop:14, display:'flex', justifyContent:'space-between', alignItems:'center', gap:10 }}>
                          <span style={{ fontSize:11, color:'#7b8ba0' }}>{selectedStudentNotification.is_read ? 'Read notification' : 'Marking as read...'}</span>
                          <IonButton type="button" onClick={() => setSelectedStudentNotification(null)}>Close</IonButton>
                        </div>
                      </section>
                    </div>
                  )}
                </section>
              )}
              {!isAdmin && page === 'user-guidelines' && (
                <section className="settings-page">
                  <button type="button" className="settings-shortcut" onClick={navigateBack}><b>‹</b><span><strong>Back to Settings</strong><small>Return to Account &amp; Support</small></span></button>
                  <div className="settings-section-title"><div><span>LIBRARY INFORMATION</span><h3>Library Guidelines</h3></div><p>Helpful reminders for using the NEUST Peñaranda Off-Campus Library.</p></div>
                  <div style={{ display:'grid', gap:12 }}>
                    <article className="settings-card" style={{ width:'100%' }}>
                      <div className="settings-card-top"><span className="settings-card-icon gold">📖</span><span className="settings-card-label">BORROWING BOOKS</span></div>
                      <h3>Before borrowing</h3>
                      <ul style={{ paddingLeft:20, color:'#718198', lineHeight:1.8 }}>
                        <li>Check the book details and availability in the Book Catalog.</li>
                        <li>Make sure you are signed in using your own LibTrack account.</li>
                        <li>Review the borrowing information and due date shown in your account.</li>
                      </ul>
                    </article>
                    <article className="settings-card" style={{ width:'100%' }}>
                      <div className="settings-card-top"><span className="settings-card-icon gold">🗓️</span><span className="settings-card-label">RETURNING BOOKS</span></div>
                      <h3>Return reminders</h3>
                      <ul style={{ paddingLeft:20, color:'#718198', lineHeight:1.8 }}>
                        <li>Return borrowed books on or before the due date recorded in LibTrack.</li>
                        <li>Keep borrowed materials clean and in good condition.</li>
                        <li>Contact the library staff promptly if a book is lost or damaged.</li>
                      </ul>
                    </article>
                    <article className="settings-card" style={{ width:'100%' }}>
                      <div className="settings-card-top"><span className="settings-card-icon gold">🏛️</span><span className="settings-card-label">LIBRARY POLICIES</span></div>
                      <h3>Follow official library instructions</h3>
                      <p style={{ color:'#718198', lineHeight:1.7 }}>Borrowing limits, loan periods, penalties, opening hours, and other official rules are determined by the library administrator or librarian. Follow the latest instructions provided by the NEUST Peñaranda Off-Campus Library.</p>
                    </article>
                  </div>
                </section>
              )}
              {!isAdmin && page === 'user-support' && (
                <section className="settings-page">
                  <button type="button" className="settings-shortcut" onClick={navigateBack}><b>‹</b><span><strong>Back to Settings</strong><small>Return to Account &amp; Support</small></span></button>
                  <div className="settings-section-title"><div><span>NEED ASSISTANCE?</span><h3>Help &amp; Support</h3></div><p>Quick answers to common questions about using LibTrack.</p></div>
                  <div style={{ display:'grid', gap:11 }}>
                    {[
                      ['How do I find a book?','Open the Book Catalog or Categories, then browse or search for the title you need. Open a book to view its details and availability.'],
                      ['Where can I see my borrowed books?','Open your borrowing history to review your current and previous borrowing records, including due-date information when available.'],
                      ['Where can I read library announcements?','Open Notification History in Settings or use the notification icon to view library updates.'],
                      ['How do I update my account details?','Open Profile Information. If a detail cannot be edited, contact the library administrator for assistance.'],
                      ['What if I cannot sign in?','Check that your account credentials are correct. If the issue continues, ask the library administrator to help verify your account.'],
                      ['Who can help with library rules?','For official borrowing policies, due dates, penalties, and library schedules, ask the NEUST Peñaranda Off-Campus librarian or administrator.']
                    ].map(([question, answer], index) => (
                      <details key={`support-faq-${index}`} className="settings-card" style={{ width:'100%', padding:16 }}>
                        <summary style={{ cursor:'pointer', color:'#193550', fontWeight:750, lineHeight:1.5 }}>{question}</summary>
                        <p style={{ margin:'10px 0 0', color:'#718198', lineHeight:1.7 }}>{answer}</p>
                      </details>
                    ))}
                  </div>
                </section>
              )}
              {!isAdmin && page === 'user-report' && (
                <section className="settings-page">
                  <button type="button" className="settings-shortcut" onClick={navigateBack}><b>‹</b><span><strong>Back to Settings</strong><small>Return to Account &amp; Support</small></span></button>
                  <div className="settings-section-title"><div><span>FEEDBACK &amp; ASSISTANCE</span><h3>Report a Problem</h3></div><p>Describe the issue so you can share the details with the library administrator.</p></div>
                  <form className="settings-card" style={{ width:'100%', display:'grid', gap:14 }} onSubmit={async (event) => {
                    event.preventDefault();
                    if (!token || !problemDescription.trim() || problemReportSubmitting) return;
                    setProblemReportSubmitting(true);
                    setProblemReportMessage('');
                    try {
                      const response = await fetch(`${API}/problem-reports`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                        body: JSON.stringify({ category: problemCategory, description: problemDescription.trim() }),
                      });
                      const data = await response.json().catch(() => ({}));
                      if (!response.ok) throw new Error(data.detail || data.message || `Submission failed (${response.status}).`);
                      setProblemReportMessage(`Your report #${data.report?.id ?? ''} was submitted successfully. The library administrator can now review it.`);
                      setProblemDescription('');
                    } catch (error) {
                      setProblemReportMessage(error instanceof Error ? error.message : 'Unable to submit your report. Please try again.');
                    } finally {
                      setProblemReportSubmitting(false);
                    }
                  }}>
                    <label className="settings-field">Problem Category
                      <select value={problemCategory} onChange={(event) => { setProblemCategory(event.target.value); setProblemReportMessage(''); }} style={{ display:'block', width:'100%', marginTop:7, padding:12, border:'1px solid #dce4ed', borderRadius:10, background:'#fff', color:'#193550' }}>
                        <option>Account or profile</option>
                        <option>Login or password</option>
                        <option>Book catalog or book details</option>
                        <option>Borrowing or return record</option>
                        <option>Research Library or E-Books</option>
                        <option>Notification</option>
                        <option>Technical issue</option>
                        <option>Other</option>
                      </select>
                    </label>
                    <label className="settings-field">Describe the problem
                      <textarea value={problemDescription} onChange={(event) => { setProblemDescription(event.target.value); setProblemReportMessage(''); }} rows={6} maxLength={2000} required placeholder="Tell us what happened and which page or feature you were using..." style={{ display:'block', width:'100%', marginTop:7, padding:12, border:'1px solid #dce4ed', borderRadius:10, resize:'vertical', boxSizing:'border-box', font:'inherit', color:'#193550' }} />
                    </label>
                    <p style={{ margin:0, color:'#8a98aa', fontSize:12 }}>{problemDescription.length}/2000 characters</p>
                    <IonButton
                      type="submit"
                      expand="block"
                      className="submit-problem-report-button"
                      disabled={!problemDescription.trim() || problemReportSubmitting}
                      style={{
                        '--background': '#f6c445',
                        '--background-hover': '#eab52e',
                        '--background-activated': '#dca51e',
                        '--background-focused': '#eab52e',
                        '--color': '#17324d',
                        '--color-activated': '#17324d',
                        '--color-focused': '#17324d',
                        '--border-radius': '13px',
                        '--box-shadow': '0 4px 12px rgba(23, 50, 77, 0.16)',
                        fontWeight: 800,
                        fontSize: '16px',
                        letterSpacing: '0.2px',
                        minHeight: '52px',
                        opacity: 1,
                      } as React.CSSProperties}
                    >
                      {problemReportSubmitting ? 'Submitting your report...' : 'SUBMIT REPORT'}
                    </IonButton>
                    {!problemDescription.trim() && !problemReportSubmitting && (
                      <p style={{ margin:'-6px 0 0', color:'#66788d', fontSize:13, lineHeight:1.5 }}>
                        Enter a description above to enable the Submit Report button.
                      </p>
                    )}
                    {problemReportMessage && <p role="status" aria-live="polite" style={{ margin:0, color:problemReportMessage.toLowerCase().includes('successfully') ? '#087a43' : '#b42318', lineHeight:1.6 }}>{problemReportMessage}</p>}
                    <p style={{ margin:0, color:'#8a98aa', fontSize:12, lineHeight:1.6 }}>Your report will be sent securely to the LibTrack server for the library administrator to review.</p>
                  </form>
                </section>
              )}
              {!isAdmin && page === 'user-privacy' && (
                <section className="settings-page">
                  <button type="button" className="settings-shortcut" onClick={navigateBack}><b>‹</b><span><strong>Back to Settings</strong><small>Return to Account &amp; Support</small></span></button>
                  <div className="settings-section-title"><div><span>ACCOUNT PROTECTION</span><h3>Privacy &amp; Security</h3></div><p>Simple steps to help keep your LibTrack account and information safe.</p></div>
                  <div style={{ display:'grid', gap:12 }}>
                    <article className="settings-card" style={{ width:'100%' }}>
                      <div className="settings-card-top"><span className="settings-card-icon violet">🔐</span><span className="settings-card-label">KEEP YOUR ACCOUNT SAFE</span></div>
                      <h3>Protect your sign-in details</h3>
                      <ul style={{ paddingLeft:20, color:'#718198', lineHeight:1.8 }}>
                        <li>Do not share your password with other people.</li>
                        <li>Use Change Password if you believe someone else knows your password.</li>
                        <li>Always log out when using a shared or public device.</li>
                        <li>Keep your account and profile information accurate.</li>
                      </ul>
                    </article>
                    <article className="settings-card" style={{ width:'100%' }}>
                      <div className="settings-card-top"><span className="settings-card-icon violet">🗂️</span><span className="settings-card-label">ACCOUNT INFORMATION</span></div>
                      <h3>Your library account</h3>
                      <p style={{ color:'#718198', lineHeight:1.7 }}>LibTrack uses account and library activity information to provide services such as profile access, borrowing records, and notifications. Only enter information needed for your library account, and contact the library administrator if you notice an incorrect detail.</p>
                    </article>
                    <article className="settings-card" style={{ width:'100%' }}>
                      <div className="settings-card-top"><span className="settings-card-icon violet">🛡️</span><span className="settings-card-label">NEED HELP?</span></div>
                      <h3>Report an account concern</h3>
                      <p style={{ color:'#718198', lineHeight:1.7 }}>If you notice unfamiliar activity or think your account may be at risk, change your password and contact the library administrator.</p>
                      <IonButton expand="block" fill="outline" onClick={() => navigate('user-report')}>Report a Problem</IonButton>
                    </article>
                  </div>
                </section>
              )}
              {!isAdmin && page === 'user-library-schedule' && (
                <section className="settings-page">
                  <button type="button" className="settings-shortcut" onClick={navigateBack}><b>‹</b><span><strong>Back to Settings</strong><small>Return to Account &amp; Support</small></span></button>
                  <div className="settings-section-title"><div><span>PLAN YOUR VISIT</span><h3>Library Schedule</h3></div><p>Check the latest opening hours configured by the library administrator.</p></div>
                  <article className="settings-card" style={{ width:'100%' }}>
                    <div className="settings-card-top"><span className="settings-card-icon gold">🗓️</span><span className="settings-card-label">WEEKLY OPENING HOURS</span></div>
                    {Object.entries(librarySchedule).map(([day, hours]) => (
                      <div key={day} style={{ display:'flex', justifyContent:'space-between', gap:12, padding:'12px 0', borderBottom:'1px solid #edf1f5', color:'#526579' }}>
                        <strong style={{ color:'#193550' }}>{day}</strong>
                        <span>{hours.closed ? 'Closed' : `${hours.open} – ${hours.close}`}</span>
                      </div>
                    ))}
                    <p style={{ color:'#8795a7', fontSize:12, lineHeight:1.6, margin:'14px 0 0' }}>Schedules may change during holidays or special announcements. Please follow the latest notice from the library.</p>
                  </article>
                </section>
              )}
              {!isAdmin && page === 'user-requests' && (
                <section className="settings-page">
                  <button type="button" className="settings-shortcut" onClick={navigateBack}><b>‹</b><span><strong>Back to Settings</strong><small>Return to Account &amp; Support</small></span></button>
                  <div className="settings-section-title"><div><span>YOUR LIBRARY ACTIVITY</span><h3>My Requests</h3></div><p>Review the status of your borrowing requests and past borrowing records.</p></div>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:10, marginBottom:12 }}>
                    <span style={{ color:'#718198', fontSize:13 }}>{borrowings.length} request/record(s)</span>
                    <IonButton size="small" fill="outline" onClick={() => navigate('borrowings')}>Full Borrowing History</IonButton>
                  </div>
                  {borrowingsLoading && <article className="settings-card"><p>Loading your requests...</p></article>}
                  {borrowingsError && <article className="settings-card"><p role="alert">Could not load requests: {borrowingsError}</p></article>}
                  {!borrowingsLoading && !borrowingsError && borrowings.length === 0 && (
                    <article className="settings-card" style={{ width:'100%', textAlign:'center', padding:26 }}>
                      <div style={{ fontSize:34 }}>📋</div><h3>No requests yet</h3><p style={{ color:'#718198' }}>Your borrowing requests will appear here after you request a book.</p>
                      <IonButton fill="solid" color="primary" className="browse-book-button" style={{ "--background": "#173b5e", "--background-hover": "#102d49", "--color": "#ffffff", "--color-activated": "#ffffff", "--color-focused": "#ffffff", fontWeight: 700, letterSpacing: "0.2px" } as React.CSSProperties} onClick={() => navigate('categories')}>Browse Book</IonButton>
                    </article>
                  )}
                  <div style={{ display:'grid', gap:10 }}>
                    {borrowings.map((record) => {
                      const relatedBook = books.find((book) => book.id === record.book_id);
                      const status = String(record.status || 'pending').replace(/_/g, ' ');
                      return (
                        <article key={`my-request-${record.id}`} className="settings-card" style={{ width:'100%', padding:16 }}>
                          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:12 }}>
                            <div><strong style={{ color:'#193550' }}>{relatedBook?.title || `Book #${record.book_id}`}</strong><p style={{ margin:'5px 0', color:'#718198', fontSize:12 }}>Request / Record #{record.id}</p></div>
                            <IonBadge color={/return|complete/i.test(status) ? 'success' : /overdue|lost|damage/i.test(status) ? 'danger' : 'primary'}>{status}</IonBadge>
                          </div>
                          <div style={{ display:'flex', justifyContent:'space-between', gap:10, marginTop:10, color:'#718198', fontSize:12 }}>
                            <span>Requested/Borrowed: {record.borrowed_at ? new Date(record.borrowed_at).toLocaleDateString() : 'Not available'}</span>
                            <span>Due: {record.due_date ? new Date(record.due_date).toLocaleDateString() : 'Not set'}</span>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              )}
              {!isAdmin && page === 'user-saved-books' && (
                <section className="settings-page">
                  <button type="button" className="settings-shortcut" onClick={navigateBack}><b>‹</b><span><strong>Back to Settings</strong><small>Return to Account &amp; Support</small></span></button>
                  <div className="settings-section-title"><div><span>YOUR PERSONAL LIST</span><h3>Saved Books</h3></div><p>Books you saved from the Book Catalog for quick reference.</p></div>
                  {savedBookIds.length === 0 && (
                    <article className="settings-card" style={{ width:'100%', textAlign:'center', padding:26 }}>
                      <div style={{ fontSize:34 }}>🔖</div><h3>No saved books yet</h3><p style={{ color:'#718198' }}>Open the Book Catalog and tap ☆ Save on a book you want to revisit.</p>
                      <IonButton fill="solid" color="primary" className="browse-book-button" style={{ "--background": "#173b5e", "--background-hover": "#102d49", "--color": "#ffffff", "--color-activated": "#ffffff", "--color-focused": "#ffffff", fontWeight: 700, letterSpacing: "0.2px" } as React.CSSProperties} onClick={() => navigate('categories')}>Browse Book</IonButton>
                    </article>
                  )}
                  <div style={{ display:'grid', gap:12 }}>
                    {savedBookIds.map((bookId) => {
                      const book = books.find((item) => item.id === bookId);
                      if (!book) return null;
                      return (
                        <article key={`saved-book-${book.id}`} className="settings-card" style={{ width:'100%', display:'grid', gridTemplateColumns:'64px minmax(0,1fr)', gap:14, alignItems:'center', padding:14 }}>
                          <div className="saved-book-cover-frame" style={{ position:'relative', width:64, minWidth:64, maxWidth:64, height:84, minHeight:84, maxHeight:84, overflow:'hidden', borderRadius:9, background:'#edf2f7', flexShrink:0, boxSizing:'border-box' }}><BookCover book={book} className="book-cover saved-book-cover" /></div>
                          <div style={{ minWidth:0 }}>
                            <strong style={{ color:'#193550' }}>{book.title}</strong>
                            <p style={{ margin:'5px 0', color:'#718198', fontSize:12 }}>{book.author}</p>
                            <p style={{ margin:'5px 0 9px', color:book.available_copies > 0 ? '#16834b' : '#b45a45', fontSize:12 }}>{book.available_copies} available</p>
                            <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                              <IonButton size="small" fill="outline" onClick={() => { setSelectedBook(book); navigate('books'); }}>View Details</IonButton>
                              <IonButton size="small" fill="clear" color="danger" onClick={() => toggleSavedBook(book.id)}>Remove</IonButton>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              )}
              {!isAdmin && page === 'user-preferences' && (
                <section className="settings-page">
                  <button type="button" className="settings-shortcut" onClick={navigateBack}><b>‹</b><span><strong>Back to Settings</strong><small>Return to Account &amp; Support</small></span></button>
                  <div className="settings-section-title"><div><span>PERSONALIZE LIBTRACK</span><h3>App Preferences</h3></div><p>Choose the types of library updates you want to see in your account.</p></div>
                  <article className="settings-card" style={{ width:'100%', display:'grid', gap:0 }}>
                    {([
                      ['borrowingUpdates', 'Borrowing Updates', 'Status changes for your borrowing requests and returns.'],
                      ['dueDateReminders', 'Due-date Reminders', 'Reminders about books that are approaching their due dates.'],
                      ['libraryAnnouncements', 'Library Announcements', 'Notices about library schedules, holidays, and service updates.'],
                    ] as const).map(([key, title, description], index) => (
                      <div key={key} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:16, padding:'15px 0', borderBottom:index < 2 ? '1px solid #edf1f5' : '0' }}>
                        <div style={{ flex:1 }}>
                          <strong style={{ color:'#193550' }}>{title}</strong>
                          <p style={{ margin:'5px 0 0', color:'#718198', fontSize:12, lineHeight:1.5 }}>{description}</p>
                        </div>
                        <input type="checkbox" checked={preferences[key]} onChange={(event) => updateAppPreference(key, event.target.checked)} aria-label={title} style={{ width:22, height:22, accentColor:'#173b59', flexShrink:0 }} />
                      </div>
                    ))}
                    <p style={{ color:'#8795a7', fontSize:12, lineHeight:1.6, margin:'14px 0 0' }}>These preferences are saved on this device for your account. They do not yet change server-generated notifications or email delivery.</p>
                  </article>
                </section>
              )}
              {!isAdmin && page === 'user-about' && (
                <section className="settings-page">
                  <button type="button" className="settings-shortcut" onClick={navigateBack}><b>‹</b><span><strong>Back to Settings</strong><small>Return to Account & Support</small></span></button>
                  <div className="settings-section-title"><div><span>SYSTEM INFORMATION</span><h3>About LibTrack</h3></div><p>Learn more about the library portal.</p></div>
                  <article className="settings-card" style={{ width:'100%' }}>
                    <div className="settings-card-top"><span className="settings-card-icon violet">ℹ️</span><span className="settings-card-label">NEUST PEÑARANDA OFF-CAMPUS</span></div>
                    <h3>LibTrack · Library Portal</h3>
                    <p>NEUST Peñaranda Off-Campus Library Management System.</p>
                    <div className="settings-about-note">A centralized space for books, borrowing records, e-books, and academic research.</div>
                  </article>
                </section>
              )}

              {/* ADMIN SETTINGS: SEPARATE PAGES */}
              {isAdmin && page === 'admin-problem-reports' && (
                <section className="settings-page">
                  <button type="button" className="settings-shortcut" onClick={navigateBack}><b>‹</b><span><strong>Back to Settings</strong><small>Return to Manage LibTrack</small></span></button>
                  <div className="settings-section-title"><div><span>ADMINISTRATOR ONLY</span><h3>Problem Reports</h3></div><p>Review issues submitted by students and faculty, then update their status.</p></div>
                  <div style={{ display:'flex', justifyContent:'flex-end' }}><IonButton fill="outline" onClick={() => void loadAdminProblemReports()} disabled={adminProblemReportsLoading}>{adminProblemReportsLoading ? 'Refreshing...' : 'Refresh Reports'}</IonButton></div>
                  {adminProblemReportError && <p role="alert" style={{ color:'#b42318' }}>{adminProblemReportError}</p>}
                  {adminProblemReportsLoading && <p>Loading reports...</p>}
                  {!adminProblemReportsLoading && adminProblemReports.length === 0 && !adminProblemReportError && <article className="settings-card"><p style={{ margin:0, color:'#718198' }}>No problem reports have been submitted yet.</p></article>}
                  <div style={{ display:'grid', gap:12 }}>
                    {adminProblemReports.map((report) => (
                      <article className="settings-card" key={report.id} style={{ display:'grid', gap:10 }}>
                        <div style={{ display:'flex', justifyContent:'space-between', gap:10, flexWrap:'wrap' }}><strong>Report #{report.id} · {report.category}</strong><span style={{ fontWeight:750, color:report.status === 'resolved' ? '#087a43' : report.status === 'in_progress' ? '#a16207' : '#64748b' }}>{String(report.status || 'pending').replace('_',' ').toUpperCase()}</span></div>
                        <p style={{ margin:0, color:'#52657b' }}><strong>Submitted by:</strong> {report.student_name || 'Unknown'} ({report.student_email || 'No email'})</p>
                        <p style={{ margin:0, color:'#52657b', whiteSpace:'pre-wrap' }}>{report.description}</p>
                        {report.created_at && <small style={{ color:'#8a98aa' }}>{new Date(report.created_at).toLocaleString()}</small>}
                        {report.admin_note && <p style={{ margin:0, color:'#52657b' }}><strong>Admin note:</strong> {report.admin_note}</p>}
                        <label className="settings-field">Update status
                          <select value={report.status || 'pending'} onChange={(event) => void updateAdminProblemReport(Number(report.id), event.target.value, report.admin_note || '')} style={{ display:'block', width:'100%', marginTop:7, padding:12, border:'1px solid #dce4ed', borderRadius:10, background:'#fff', color:'#193550' }}>
                            <option value="pending">Pending</option><option value="in_progress">In Progress</option><option value="resolved">Resolved</option>
                          </select>
                        </label>
                      </article>
                    ))}
                  </div>
                </section>
              )}

              {isAdmin && page === 'admin-connection' && (
                <section className="settings-page">
                  <button type="button" className="settings-shortcut" onClick={navigateBack}><b>‹</b><span><strong>Back to Settings</strong><small>Return to Manage LibTrack</small></span></button>
                  <div className="settings-section-title"><div><span>SYSTEM MANAGEMENT</span><h3>System Connection</h3></div><p>Check whether the frontend can reach the LibTrack backend.</p></div>
                  <article className="settings-panel settings-admin-panel"><div className="settings-weekend-box" style={{ marginBottom: '18px' }}>
                        <div className="settings-weekend-heading">
                          <div><h4>System Connection</h4><p>Check whether the LibTrack frontend can reach the FastAPI backend.</p></div>
                          <span className="settings-notice-icon">🖥️</span>
                        </div>
                        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, flexWrap:'wrap' }}>
                          <div style={{ display:'flex', alignItems:'center', gap:9, color:'#344b63', fontWeight:750 }}>
                            <span aria-hidden="true" style={{ width:10, height:10, borderRadius:'50%', background:apiHealthStatus === 'online' ? '#16a34a' : apiHealthStatus === 'offline' ? '#dc2626' : apiHealthStatus === 'checking' ? '#d69e2e' : '#94a3b8' }} />
                            {apiHealthStatus === 'online' ? 'API ONLINE' : apiHealthStatus === 'offline' ? 'API OFFLINE' : apiHealthStatus === 'checking' ? 'CHECKING...' : 'NOT CHECKED'}
                          </div>
                          <IonButton type="button" fill="outline" onClick={() => void checkAdminApiHealth()} disabled={apiHealthStatus === 'checking'}>
                            {apiHealthStatus === 'checking' ? 'Checking...' : 'Check Connection'}
                          </IonButton>
                        </div>
                        {apiHealthMessage && <p role="status" aria-live="polite" style={{ margin:'8px 0 0', fontSize:13, color:apiHealthStatus === 'online' ? '#087a43' : apiHealthStatus === 'offline' ? '#b42318' : '#607b99' }}>{apiHealthMessage}</p>}
                      </div></article>
                </section>
              )}
              {isAdmin && page === 'admin-borrowing-schedule' && (
                <section className="settings-page">
                  <button type="button" className="settings-shortcut" onClick={navigateBack}><b>‹</b><span><strong>Back to Settings</strong><small>Return to Manage LibTrack</small></span></button>
                  <div className="settings-section-title"><div><span>SYSTEM MANAGEMENT</span><h3>Borrowing Schedule</h3></div><p>Control when students and faculty can submit borrowing requests.</p></div>
                  <article className="settings-panel settings-admin-panel"><div className="settings-weekend-box" style={{ marginBottom: '18px' }}>
                        <div className="settings-weekend-heading"><div><h4>Borrowing Schedule</h4><p>Choose when Students and Faculty may submit book borrowing requests. Philippine Time (UTC+8).</p></div><span className="settings-notice-icon">📚</span></div>
                        <label className="settings-check">
                          <input type="checkbox" checked={borrowingSchedule.enabled} onChange={(event) => setBorrowingSchedule((current) => ({ ...current, enabled: event.target.checked }))} />
                          <span><strong>Enable book borrowing</strong><small>Turn this off to temporarily stop all new borrowing requests.</small></span>
                        </label>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: 10, margin: '14px 0' }}>
                          <label className="settings-field">Opens at<input type="time" value={borrowingSchedule.open_time} disabled={!borrowingSchedule.enabled} onChange={(event) => setBorrowingSchedule((current) => ({ ...current, open_time: event.target.value }))} /></label>
                          <label className="settings-field">Closes at<input type="time" value={borrowingSchedule.close_time} disabled={!borrowingSchedule.enabled} onChange={(event) => setBorrowingSchedule((current) => ({ ...current, close_time: event.target.value }))} /></label>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8, margin: '12px 0' }}>
                          {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day) => (
                            <label key={day} className="settings-check" style={{ margin: 0, padding: '8px 10px', border: '1px solid #e5eaf0', borderRadius: 8 }}>
                              <input type="checkbox" checked={borrowingSchedule.days.includes(day)} disabled={!borrowingSchedule.enabled} onChange={(event) => setBorrowingSchedule((current) => ({ ...current, days: event.target.checked ? [...current.days, day] : current.days.filter((item) => item !== day) }))} />
                              <span><strong>{day}</strong></span>
                            </label>
                          ))}
                        </div>
                        <label className="settings-field">Message when borrowing is closed<textarea rows={2} maxLength={500} value={borrowingSchedule.message} onChange={(event) => setBorrowingSchedule((current) => ({ ...current, message: event.target.value }))} /></label>
                        <IonButton type="button" expand="block" onClick={() => void saveBorrowingSchedule()} disabled={borrowingScheduleSaving}>{borrowingScheduleSaving ? 'Saving...' : 'Save Borrowing Schedule'}</IonButton>
                        {borrowingScheduleMessage && <p role="status" aria-live="polite" style={{ margin: '10px 0 0', color: borrowingScheduleMessage.includes('successfully') ? '#087a43' : borrowingScheduleMessage.startsWith('Saving') ? '#607b99' : '#b42318', fontSize: 13, fontWeight: 700 }}>{borrowingScheduleMessage}</p>}
                      </div></article>
                </section>
              )}
              {isAdmin && page === 'admin-library-schedule' && (
                <section className="settings-page">
                  <button type="button" className="settings-shortcut" onClick={navigateBack}><b>‹</b><span><strong>Back to Settings</strong><small>Return to Manage LibTrack</small></span></button>
                  <div className="settings-section-title"><div><span>SYSTEM MANAGEMENT</span><h3>Library Schedule</h3></div><p>Manage the opening and closing hours shown to library users.</p></div>
                  <article className="settings-panel settings-admin-panel"><div className="settings-weekend-box" style={{ marginBottom: '18px' }}>
                        <div className="settings-weekend-heading"><div><h4>Library Schedule</h4><p>Set the opening and closing hours shown to students on their Home page. Philippine Time (UTC+8).</p></div><span className="settings-notice-icon">🕒</span></div>
                        <div style={{ display: 'grid', gap: '10px', margin: '14px 0' }}>
                          {(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const).map((day) => {
                            const value = librarySchedule[day] || { closed: true, open: '08:00', close: '12:00' };
                            return <div key={day} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', alignItems: 'center', gap: '10px', padding: '10px 12px', border: '1px solid #e3eaf2', borderRadius: '10px', background: '#fff' }}>
                              <strong style={{ color: '#20364f' }}>{day}</strong>
                              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#526b86' }}><input type="checkbox" checked={value.closed} onChange={(event) => setLibrarySchedule((current) => ({ ...current, [day]: { ...value, closed: event.target.checked } }))} /> Closed</label>
                              <label className="settings-field" style={{ margin: 0, fontSize: '12px' }}>Opens<input aria-label={`${day} opening time`} type="time" value={value.open} disabled={value.closed} onChange={(event) => setLibrarySchedule((current) => ({ ...current, [day]: { ...value, open: event.target.value } }))} /></label>
                              <label className="settings-field" style={{ margin: 0, fontSize: '12px' }}>Closes<input aria-label={`${day} closing time`} type="time" value={value.close} disabled={value.closed} onChange={(event) => setLibrarySchedule((current) => ({ ...current, [day]: { ...value, close: event.target.value } }))} /></label>
                            </div>;
                          })}
                        </div>
                        <IonButton type="button" expand="block" onClick={() => void saveLibrarySchedule()} disabled={libraryScheduleSaving}>
                          {libraryScheduleSaving ? 'Saving...' : 'Save Library Schedule'}
                        </IonButton>
                        {libraryScheduleMessage && (
                          <IonText color={libraryScheduleMessage.startsWith('Library schedule saved') ? 'success' : libraryScheduleMessage.startsWith('Saving') ? 'medium' : 'danger'}>
                            <p role="status" aria-live="polite" style={{ margin: '10px 0 0', fontSize: '13px', fontWeight: 600 }}>
                              {libraryScheduleMessage}
                            </p>
                          </IonText>
                        )}
                      </div></article>
                </section>
              )}
              {isAdmin && page === 'admin-weekend-notice' && (
                <section className="settings-page">
                  <button type="button" className="settings-shortcut" onClick={navigateBack}><b>‹</b><span><strong>Back to Settings</strong><small>Return to Manage LibTrack</small></span></button>
                  <div className="settings-section-title"><div><span>NOTIFICATION SETTINGS</span><h3>Weekend Borrowing Notice</h3></div><p>Set the time and message for the Saturday and Sunday student pop-up.</p></div>
                  <article className="settings-panel settings-admin-panel"><div className="settings-weekend-box">
                        <div className="settings-weekend-heading"><div><h4>Weekend Borrowing Notice</h4><p>Set the Philippine time when students will see the pop-up every Saturday and Sunday.</p></div><span className="settings-notice-icon">🔔</span></div>
                        <label className="settings-check"><input type="checkbox" checked={weekendNoticeEnabled} onChange={(event) => setWeekendNoticeEnabled(event.target.checked)} /> <span><strong>Enable weekend notice</strong><small>Automatically show the notice to students on Saturdays and Sundays.</small></span></label>
                        <div className="settings-weekend-fields">
                          <label className="settings-field">Pop-up time <small>Philippine Standard Time (UTC+8)</small><input type="time" value={weekendNoticeTime} onChange={(event) => setWeekendNoticeTime(event.target.value)} /></label>
                          <label className="settings-field">Message shown to students <small>Keep the message clear and informative.</small><textarea value={weekendNoticeMessage} onChange={(event) => setWeekendNoticeMessage(event.target.value)} rows={3} maxLength={1000} /></label>
                        </div>
                        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(180px, 1fr))', gap:10 }}>
                          <IonButton type="button" expand="block" fill="outline" onClick={() => setShowAdminNoticePreview(true)}>Preview Student Pop-up</IonButton>
                          <IonButton type="button" expand="block" onClick={() => void saveWeekendNoticeSettings()} disabled={weekendNoticeSaving || !weekendNoticeMessage.trim()}>{weekendNoticeSaving ? 'Saving...' : 'Save Weekend Notice Settings'}</IonButton>
                        </div>
                        {weekendNoticeSaveMessage && (
                          <p role="status" aria-live="polite" style={{
                            margin: '10px 0 0',
                            color: weekendNoticeSaveMessage.startsWith('Hindi na-save') ? '#b42318' : '#176b45',
                            fontSize: '13px',
                            fontWeight: 600,
                          }}>
                            {weekendNoticeSaveMessage}
                          </p>
                        )}
                      </div>{showAdminNoticePreview && (
                        <div role="presentation" onClick={() => setShowAdminNoticePreview(false)} style={{ position:'fixed', inset:0, zIndex:15000, display:'grid', placeItems:'center', padding:18, background:'rgba(7,24,43,.68)', backdropFilter:'blur(5px)' }}>
                          <section role="dialog" aria-modal="true" aria-labelledby="admin-notice-preview-title" onClick={(event) => event.stopPropagation()} style={{ width:'min(100%, 440px)', background:'#fff', color:'#18324d', borderRadius:18, padding:22, boxShadow:'0 24px 70px rgba(10,30,52,.32)' }}>
                            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:12 }}>
                              <div><span style={{ color:'#b18425', fontSize:10, fontWeight:850, letterSpacing:'.12em' }}>LIBTRACK · NOTICE PREVIEW</span><h3 id="admin-notice-preview-title" style={{ margin:'5px 0 0', fontSize:20 }}>Weekend Borrowing Notice</h3></div>
                              <button type="button" onClick={() => setShowAdminNoticePreview(false)} aria-label="Close preview" style={{ border:0, borderRadius:9, width:36, height:36, background:'#eef2f7', color:'#243b55', fontSize:21, cursor:'pointer' }}>×</button>
                            </div>
                            <div style={{ marginTop:18, padding:16, borderRadius:12, background:'#fff8e8', border:'1px solid #f1dba8' }}>
                              <div style={{ fontSize:25, marginBottom:8 }}>🔔</div>
                              <strong style={{ display:'block', fontSize:16, color:'#8a5a00' }}>Library Schedule Reminder</strong>
                              <p style={{ margin:'9px 0 12px', lineHeight:1.55, color:'#52657a', whiteSpace:'pre-wrap' }}>{weekendNoticeMessage.trim() || 'No notice message has been entered yet.'}</p>
                              <small style={{ color:'#8a6b35' }}>Scheduled time: {weekendNoticeTime} · Philippine Time (UTC+8)</small>
                            </div>
                            {!weekendNoticeEnabled && <p style={{ color:'#b42318', fontSize:12, marginBottom:0 }}>Notice is currently disabled. This is a preview only.</p>}
                            <IonButton type="button" expand="block" onClick={() => setShowAdminNoticePreview(false)} style={{ marginTop:14 }}>Close Preview</IonButton>
                          </section>
                        </div>
                      )}</article>
                </section>
              )}
              {isAdmin && page === 'admin-password' && (
                <section className="settings-page">
                  <button type="button" className="settings-shortcut" onClick={navigateBack}><b>‹</b><span><strong>Back to Settings</strong><small>Return to Manage LibTrack</small></span></button>
                  <div className="settings-section-title"><div><span>ACCOUNT SECURITY</span><h3>Change Password</h3></div><p>Update your administrator password securely.</p></div>
                  <article className="settings-card" style={{ width:'100%' }}>
                    <form onSubmit={(event) => void handleChangeAccountPassword(event)} style={{ display:'grid', gap:12 }}>
                      <label className="settings-field">Current Password
                        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                          <input type={showCurrentAccountPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="Enter current password" value={currentAccountPassword} onChange={(event) => { setCurrentAccountPassword(event.target.value); setChangePasswordMessage(''); }} required style={{ flex:1, minWidth:0 }} />
                          <button type="button" onClick={() => setShowCurrentAccountPassword((value) => !value)}>{showCurrentAccountPassword ? 'Hide' : 'Show'}</button>
                        </div>
                      </label>
                      <label className="settings-field">New Password <small>At least 10 characters.</small>
                        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                          <input type={showNewAccountPassword ? 'text' : 'password'} autoComplete="new-password" minLength={10} placeholder="Enter new password" value={newAccountPassword} onChange={(event) => { setNewAccountPassword(event.target.value); setChangePasswordMessage(''); }} required style={{ flex:1, minWidth:0 }} />
                          <button type="button" onClick={() => setShowNewAccountPassword((value) => !value)}>{showNewAccountPassword ? 'Hide' : 'Show'}</button>
                        </div>
                      </label>
                      <label className="settings-field">Confirm New Password
                        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                          <input type={showConfirmAccountPassword ? 'text' : 'password'} autoComplete="new-password" minLength={10} placeholder="Confirm new password" value={confirmAccountPassword} onChange={(event) => { setConfirmAccountPassword(event.target.value); setChangePasswordMessage(''); }} required style={{ flex:1, minWidth:0 }} />
                          <button type="button" onClick={() => setShowConfirmAccountPassword((value) => !value)}>{showConfirmAccountPassword ? 'Hide' : 'Show'}</button>
                        </div>
                      </label>
                      <IonButton type="submit" expand="block" disabled={changePasswordSaving}>{changePasswordSaving ? 'Saving Password...' : 'Save New Password'}</IonButton>
                      {changePasswordMessage && <p role="status" aria-live="polite">{changePasswordMessage}</p>}
                    </form>
                  </article>
                </section>
              )}

              {/* USER PROFILE */}
              {page === 'profile' && (
                <section className="quick-section" style={{ maxWidth: '980px', margin: '0 auto', padding: 0, overflow: 'hidden', border: '1px solid #dce6f2', borderRadius: '22px', background: '#ffffff', boxShadow: '0 8px 28px rgba(25, 55, 90, .08)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '24px', padding: 'clamp(20px, 4vw, 34px) clamp(18px, 4vw, 38px)', borderBottom: '1px solid #e5edf6', flexWrap: 'wrap' }}>
                    <div style={{ width: '124px', height: '124px', flex: '0 0 124px', borderRadius: '50%', display: 'grid', placeItems: 'center', overflow: 'hidden', background: '#eaf2ff', color: '#1765d1', border: '5px solid #f5f8fc', boxShadow: '0 0 0 1px #d8e4f2', fontSize: '42px', fontWeight: 700 }}>
                      {user?.profile_photo_url ? <img src={user.profile_photo_url} alt="Profile" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : (user?.full_name || user?.name || user?.email || 'U').trim().charAt(0).toUpperCase()}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <h2 style={{ margin: '0 0 8px', color: '#09284a', fontSize: '32px', fontWeight: 800 }}>{user?.full_name || user?.name || 'Library User'}</h2>
                      <p style={{ margin: '0 0 14px', color: '#58718d', fontSize: '18px', overflowWrap: 'anywhere' }}>{user?.email || 'No email provided'}</p>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '9px', borderRadius: '30px', padding: '9px 16px', background: isAdmin ? '#fff4d6' : isFaculty ? '#eaf2ff' : '#eafbf2', color: isAdmin ? '#8a5a00' : isFaculty ? '#2457a6' : '#087a43', fontWeight: 800, fontSize: '14px', letterSpacing: '.04em' }}><span>●</span>{accountRoleLabel}</span>
                      <div style={{ marginTop: 12 }}><label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 15px', borderRadius: 10, background: '#173b60', color: '#fff', fontWeight: 700, cursor: profilePhotoSaving ? 'wait' : 'pointer', opacity: profilePhotoSaving ? .6 : 1 }}>
                        {profilePhotoSaving ? 'Uploading photo…' : 'Change Profile Photo'}
                        <input type="file" accept="image/jpeg,image/png,image/webp" disabled={profilePhotoSaving} style={{ display: 'none' }} onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) { setError('Choose a JPG, PNG, or WEBP image up to 5 MB.'); return; } setProfilePhotoSaving(true); setError(''); try { const body = new FormData(); body.append('file', file); const response = await fetch(`${API}/auth/profile-photo`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body }); const data = await readResponse(response); setUser(current => current ? { ...current, profile_photo_url: data.profile_photo_url } : current); setNotice('Profile photo updated successfully.'); } catch (err) { setError(getError(err)); } finally { setProfilePhotoSaving(false); } }} />
                      </label></div>
                    </div>
                  </div>
                  <div style={{ padding: 'clamp(20px, 4vw, 30px) clamp(18px, 4vw, 38px) 20px' }}>
                    <h3 style={{ margin: '0 0 18px', color: '#09284a', fontSize: '20px', fontWeight: 800 }}>PERSONAL INFORMATION</h3>
                    {[
                      ...(isStudentAccount ? [
                        { icon: '🎓', label: 'Student ID', value: user?.student_id || 'Not provided' },
                      ] : []),
                      { icon: '👤', label: 'Username', value: user?.username || (user?.email ? user.email.split('@')[0] : 'Not provided') },
                      { icon: '✉️', label: 'Email', value: user?.email || 'Not provided' },
                      ...(isStudentAccount ? [
                        { icon: '📘', label: 'Course', value: user?.course || 'Not provided' },
                        { icon: '🎓', label: 'Year', value: user?.year || 'Not provided' },
                        { icon: '🏷️', label: 'Section', value: user?.section || 'Not provided' },
                      ] : []),
                      { icon: '🔒', label: 'Account Type', value: normalizedUserRole || 'student' },
                    ].map((item) => (
                      <div key={item.label} style={{ display: 'grid', gridTemplateColumns: '48px minmax(70px, .8fr) minmax(0, 1fr)', alignItems: 'center', gap: '16px', minHeight: '86px', borderBottom: '1px solid #e5edf6', padding: '10px 0' }}>
                        <span style={{ width: '48px', height: '48px', display: 'grid', placeItems: 'center', borderRadius: '15px', background: '#f2f6fb', fontSize: '21px' }}>{item.icon}</span>
                        <span style={{ color: '#607b99', fontSize: '18px' }}>{item.label}</span>
                        <strong style={{ color: '#09284a', fontSize: '17px', textAlign: 'right', overflowWrap: 'anywhere' }}>{item.value}</strong>
                      </div>
                    ))}
                  </div>
                  <div style={{ padding: '0 clamp(18px, 4vw, 38px) clamp(22px, 4vw, 32px)' }}>
                    <IonButton
                      expand="block"
                      color="danger"
                      fill="outline"
                      onClick={() => void confirmLogout()}
                      style={{ minHeight: '50px', fontWeight: 700, '--border-radius': '14px' }}
                    >
                      <IonIcon slot="start" icon={logOutOutline} />
                      Log Out
                    </IonButton>
                  </div>
                </section>
              )}

              {/* HOME */}

              {page === 'home' && (

                <>

                  <section

                    className={`welcome-banner ${isAdmin ? 'admin-banner' : ''}`}

                  >

                    <div className="welcome-copy">

                      <span className="gold-kicker">

                        {isAdmin

                          ? 'LIBTRACK • ADMINISTRATION'

                          : 'WELCOME TO LIBTRACK'}

                      </span>

                      <h2>

                        Hello,{' '}

                        <em>

                          {(user?.full_name || user?.name || 'Reader').split(

                            ' ',

                          )[0]}

                          !

                        </em>

                      </h2>

                      <p>

                        {isAdmin

                          ? 'Manage your library, monitor inventory, and view registered accounts.'

                          : 'Discover books, explore categories, and find your next read.'}

                      </p>

                    </div>

                    <div className="banner-art" aria-hidden="true">

                      <div className="art-circle" />

                      <div className="art-book art-book-a" />

                      <div className="art-book art-book-b" />

                      <div className="art-book art-book-c" />

                      <div className="art-plant">✦</div>

                    </div>

                  </section>

                  {!isAdmin && (
                  <section className="quick-section" aria-labelledby="library-schedule-heading" style={{ marginTop: '20px', padding: 'clamp(16px, 3vw, 24px)', border: '1px solid #e1e8f0', borderRadius: '18px', background: '#ffffff', boxShadow: '0 5px 18px rgba(23, 40, 63, .045)' }}>
                    <div className="section-heading" style={{ marginBottom: '14px' }}>
                      <div><span className="eyebrow">PLAN YOUR VISIT</span><h2 id="library-schedule-heading">Library Schedule</h2><p>Library opening and closing hours.</p></div>
                      <span aria-hidden="true" style={{ fontSize: '28px' }}>🕒</span>
                    </div>
                    <div style={{ display: 'grid', gap: '8px' }}>
                      {(() => {
                        const today = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'Asia/Manila' }).format(new Date());
                        const hours = librarySchedule[today] || { closed: true, open: '08:00', close: '12:00' };
                        const formatTime = (time: string) => { const [hourText, minute] = time.split(':'); const hour = Number(hourText); return `${hour % 12 || 12}:${minute}${hour >= 12 ? 'PM' : 'AM'}`; };
                        return <div key={today} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '14px 16px', border: '1px solid #d8e3ef', borderRadius: '11px', background: '#f4f8fc' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                            <strong style={{ color: '#20364f', fontSize: '16px' }}>{today}</strong>
                            <span style={{ color: '#9a7626', fontSize: '11px', fontWeight: 800, letterSpacing: '1px' }}>TODAY</span>
                          </div>
                          <span style={{ color: hours.closed ? '#c0392b' : '#238653', fontWeight: 700, fontSize: '14px', textAlign: 'right' }}>{hours.closed ? 'Closed' : `${formatTime(hours.open)} - ${formatTime(hours.close)}`}</span>
                        </div>;
                      })()}
                    </div>
                  </section>
                  )}

                  {isAdmin && (
                    <section className="stats-grid">

                      <article className="stat-card">

                        <div className="stat-icon blue-icon">▤</div>

                        <div>

                          <span>Total copies</span>

                          <strong>{booksLoading ? '—' : totalCopies}</strong>

                          <small>Catalog inventory</small>

                        </div>

                      </article>

                      <article className="stat-card">

                        <div className="stat-icon gold-icon">✓</div>

                        <div>

                          <span>Available copies</span>

                          <strong>

                            {booksLoading ? '—' : availableCopies}

                          </strong>

                          <small>Ready to borrow</small>

                        </div>

                      </article>

                      <article className="stat-card">

                        <div className="stat-icon mint-icon">▣</div>

                        <div>

                          <span>Book titles</span>

                          <strong>{booksLoading ? '—' : books.length}</strong>

                          <small>Catalog records</small>

                        </div>

                      </article>

                      <article className="stat-card">

                        <div className="stat-icon rose-icon">◷</div>

                        <div>

                          <span>Unavailable titles</span>

                          <strong>

                            {booksLoading ? '—' : unavailableTitles}

                          </strong>

                          <small>Currently unavailable</small>

                        </div>

                      </article>

                    </section>

                  )}

                  {isAdmin && (

                    <section className="stats-grid">

                      <article className="stat-card">

                        <div className="stat-icon blue-icon">♙</div>

                        <div>

                          <span>Registered accounts</span>

                          <strong>

                            {accountsLoading ? '—' : accounts.length}

                          </strong>

                          <small>Online and offline users</small>

                        </div>

                      </article>

                      <article className="stat-card">

                        <div className="stat-icon mint-icon">◉</div>

                        <div>

                          <span>Online accounts</span>

                          <strong>{loginSessions.length}</strong>

                          <small>Recent active sessions</small>

                        </div>

                      </article>

                    </section>

                  )}


                  <section
                    className="quick-section"
                    aria-labelledby="most-borrowed-heading"
                    style={{
                      marginTop: '20px',
                      padding: 'clamp(16px, 3vw, 24px)',
                      border: '1px solid #e1e8f0',
                      borderRadius: '18px',
                      background: '#ffffff',
                      boxShadow: '0 5px 18px rgba(23, 40, 63, .045)',
                    }}
                  >
                    <div className="section-heading" style={{ marginBottom: '16px' }}>
                      <div>
                        <span className="eyebrow">LIBRARY FAVORITES</span>
                        <h2 id="most-borrowed-heading">Most Borrowed Books</h2>
                        <p>Books ranked by the number of approved borrowing transactions.</p>
                      </div>
                      <IonBadge color="primary">Top 6</IonBadge>
                    </div>

                    {mostBorrowedBooks.length === 0 ? (
                      <p className="empty-state" style={{ margin: 0 }}>
                        No approved borrowing records yet. Popular books will appear here as students borrow them.
                      </p>
                    ) : (
                      <div
                        aria-label="Most borrowed books carousel"
                        style={{
                          display: 'flex',
                          flexDirection: 'row',
                          flexWrap: 'nowrap',
                          gap: '14px',
                          overflowX: 'auto',
                          overflowY: 'hidden',
                          alignItems: 'stretch',
                          padding: '2px 2px 12px',
                          scrollBehavior: 'smooth',
                          scrollSnapType: 'x mandatory',
                          WebkitOverflowScrolling: 'touch',
                          overscrollBehaviorX: 'contain',
                        }}
                      >
                        {mostBorrowedBooks.slice(0, 6).map((book, index) => (
                          <article
                            key={book.id}
                            style={{
                              minWidth: '155px',
                              width: '155px',
                              maxWidth: '155px',
                              flex: '0 0 155px',
                              height: '315px',
                              minHeight: '315px',
                              maxHeight: '315px',
                              boxSizing: 'border-box',
                              scrollSnapAlign: 'start',
                              display: 'flex',
                              flexDirection: 'column',
                              padding: '12px',
                              overflow: 'hidden',
                              border: '1px solid #e5ebf2',
                              borderRadius: '14px',
                              background: '#fbfcfe',
                            }}
                          >
                            <div style={{ position: 'relative', width: '100%', maxWidth: '150px', aspectRatio: '3 / 4', margin: '0 auto 11px' }}>
                              <BookCover
                                book={book}
                                index={index}
                                className="book-cover most-borrowed-cover"
                              />
                              <span
                                style={{
                                  position: 'absolute',
                                  top: '9px',
                                  left: '9px',
                                  zIndex: 5,
                                  width: '30px',
                                  minWidth: '30px',
                                  height: '30px',
                                  boxSizing: 'border-box',
                                  display: 'grid',
                                  placeItems: 'center',
                                  padding: 0,
                                  borderRadius: '50%',
                                  border: '2px solid rgba(255,255,255,.95)',
                                  background: '#173b60',
                                  color: '#fff',
                                  fontSize: '13px',
                                  lineHeight: 1,
                                  fontWeight: 800,
                                  boxShadow: '0 2px 7px rgba(0,0,0,.22)',
                                }}
                              >
                                {index + 1}
                              </span>
                            </div>
                            <strong style={{ color: '#17324f', fontSize: '13px', lineHeight: 1.4, overflowWrap: 'anywhere', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden', minHeight: '36px' }}>
                              {book.title}
                            </strong>
                            <span style={{ marginTop: '4px', color: '#667b91', fontSize: '11px', lineHeight: 1.4, display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden', minHeight: '31px' }}>
                              {book.author}
                            </span>
                            <span style={{ marginTop: 'auto', paddingTop: '10px', color: '#315a61', fontSize: '12px', fontWeight: 800 }}>
                              {book.borrow_count} {book.borrow_count === 1 ? 'borrow' : 'borrows'}
                            </span>
                          </article>
                        ))}
                      </div>
                    )}
                  </section>

                                    {isAdmin && (
                    <section
                      className="quick-section"
                      aria-labelledby="most-borrowing-students-heading"
                      style={{
                        marginTop: '20px',
                        padding: 'clamp(16px, 3vw, 24px)',
                        border: '1px solid #e1e8f0',
                        borderRadius: '18px',
                        background: '#ffffff',
                        boxShadow: '0 5px 18px rgba(23, 40, 63, .045)',
                      }}
                    >
                      <div className="section-heading" style={{ marginBottom: '16px' }}>
                        <div>
                          <span className="eyebrow">STUDENT ACTIVITY</span>
                          <h2 id="most-borrowing-students-heading">Students Who Borrow the Most</h2>
                          <p>Ranked by approved borrowing transactions. Pending requests are not included.</p>
                        </div>
                        <IonBadge color="primary">Top 5</IonBadge>
                      </div>

                      {mostBorrowingStudents.length === 0 ? (
                        <p className="empty-state" style={{ margin: 0 }}>
                          No approved student borrowing records yet.
                        </p>
                      ) : (
                        <div style={{ display: 'grid', gap: '10px' }}>
                          {mostBorrowingStudents.slice(0, 5).map((student, index) => (
                            <article
                              key={student.id}
                              style={{
                                display: 'grid',
                                gridTemplateColumns: '34px minmax(0, 1fr) auto',
                                alignItems: 'center',
                                gap: '12px',
                                padding: '13px 14px',
                                border: '1px solid #e5ebf2',
                                borderRadius: '13px',
                                background: index === 0 ? '#f7faff' : '#fff',
                              }}
                            >
                              <span style={{
                                width: '30px', height: '30px', display: 'grid', placeItems: 'center',
                                borderRadius: '50%', background: index === 0 ? '#173b60' : '#edf2f7',
                                color: index === 0 ? '#fff' : '#49627c', fontSize: '12px', fontWeight: 800,
                              }}>
                                {index + 1}
                              </span>
                              <div style={{ minWidth: 0 }}>
                                <strong style={{ display: 'block', color: '#17324f', fontSize: '14px', lineHeight: 1.4, overflowWrap: 'anywhere' }}>
                                  {student.full_name}
                                </strong>
                                <span style={{ display: 'block', marginTop: '3px', color: '#667b91', fontSize: '11px', lineHeight: 1.45 }}>
                                  {[student.student_id, student.course, student.year, student.section].filter(Boolean).join(' • ') || 'Student details not available'}
                                </span>
                              </div>
                              <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                                <strong style={{ display: 'block', color: '#315a61', fontSize: '17px' }}>{student.borrow_count}</strong>
                                <span style={{ color: '#667b91', fontSize: '10px' }}>
                                  {student.borrow_count === 1 ? 'borrow' : 'borrows'}
                                </span>
                              </div>
                            </article>
                          ))}
                        </div>
                      )}
                    </section>
                  )}

{isAdmin && (
  <>
    <section className="quick-section" style={{ marginTop: '20px', padding: 'clamp(16px, 3vw, 24px)', border: '1px solid #e1e8f0', borderRadius: '18px', background: '#fff', boxShadow: '0 5px 18px rgba(23, 40, 63, .045)' }}>
      <div className="section-heading" style={{ marginBottom: '14px' }}>
        <div><span className="eyebrow">LIBRARY TIMELINE</span><h2>Recent Library Activities</h2><p>Latest borrowing requests, checkouts, and returns.</p></div>
        <IonButton size="small" fill="outline" onClick={() => navigate('borrowings')}>View all</IonButton>
      </div>
      {adminRecentActivities.length === 0 ? <p className="empty-state" style={{ margin: 0 }}>No recent library activities yet.</p> : (
        <div style={{ display: 'grid', gap: '9px' }}>
          {adminRecentActivities.map((record) => {
            const borrower = accounts.find((account) => account.id === record.user_id);
            const borrowedBook = books.find((book) => book.id === record.book_id);
            const statusLabel = record.status === 'returned' ? 'Returned' : record.status === 'pending' ? 'Requested' : 'Borrowed';
            const statusColor = record.status === 'returned' ? 'success' : record.status === 'pending' ? 'warning' : 'primary';
            return <article key={record.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '11px 13px', border: '1px solid #e5ebf2', borderRadius: '12px' }}>
              <div style={{ minWidth: 0 }}><strong style={{ display: 'block', color: '#17324f', fontSize: '13px' }}>{borrower?.full_name || `User #${record.user_id}`}</strong><span style={{ color: '#667b91', fontSize: '11px' }}>{borrowedBook?.title || `Book #${record.book_id}`}</span></div>
              <IonBadge color={statusColor}>{statusLabel}</IonBadge>
            </article>;
          })}
        </div>
      )}
    </section>

    <section className="quick-section" style={{ marginTop: '20px', padding: 'clamp(16px, 3vw, 24px)', border: '1px solid #e1e8f0', borderRadius: '18px', background: '#fff', boxShadow: '0 5px 18px rgba(23, 40, 63, .045)' }}>
      <div className="section-heading" style={{ marginBottom: '16px' }}>
        <div><span className="eyebrow">BORROWING ANALYTICS</span><h2>Monthly Borrowing Trends</h2><p>Approved borrowing transactions over the last six months.</p></div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', alignItems: 'end', gap: 'clamp(7px, 2vw, 18px)', minHeight: '170px', padding: '12px 4px 0' }}>
        {adminMonthlyBorrowing.map((month) => <div key={month.key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'end', gap: '7px', minWidth: 0, height: '160px' }}>
          <strong style={{ color: '#315a61', fontSize: '11px' }}>{month.count}</strong>
          <div title={`${month.label}: ${month.count} approved borrowings`} style={{ width: 'min(100%, 42px)', height: `${Math.max(5, (month.count / adminMaxMonthlyBorrowing) * 112)}px`, minHeight: '5px', borderRadius: '8px 8px 3px 3px', background: 'linear-gradient(180deg, #d8b85d, #315a61)' }} />
          <span style={{ color: '#667b91', fontSize: '10px', fontWeight: 700 }}>{month.label}</span>
        </div>)}
      </div>
    </section>

    <section className="quick-section" style={{ marginTop: '20px', padding: 'clamp(16px, 3vw, 24px)', border: '1px solid #e1e8f0', borderRadius: '18px', background: '#fff', boxShadow: '0 5px 18px rgba(23, 40, 63, .045)' }}>
      <div className="section-heading" style={{ marginBottom: '14px' }}>
        <div><span className="eyebrow">COURSE ENGAGEMENT</span><h2>Most Active Courses</h2><p>Approved borrowing transactions grouped by student course.</p></div>
      </div>
      <div style={{ display: 'grid', gap: '13px' }}>
        {adminMostActiveCourses.map((item) => <div key={item.course}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginBottom: '6px' }}><strong style={{ color: '#17324f', fontSize: '13px' }}>{item.course}</strong><strong style={{ color: '#315a61', fontSize: '12px' }}>{item.count} borrows</strong></div>
          <div style={{ height: '9px', overflow: 'hidden', borderRadius: '99px', background: '#edf2f7' }}><div style={{ width: `${item.count ? (item.count / Math.max(1, adminMostActiveCourses[0]?.count)) * 100 : 0}%`, height: '100%', borderRadius: '99px', background: 'linear-gradient(90deg, #315a61, #d8b85d)' }} /></div>
        </div>)}
      </div>
    </section>
  </>
)}

                </>

              )}

              {/* E-BOOK LIBRARY */}
              {page === 'ebooks' && (
                <section className="research-library-page" style={{ padding: '8px 4px 32px', color: '#203047' }}>
                  <div className="section-heading research-heading">
                    <div>
                      <span className="eyebrow">DIGITAL COLLECTION</span>
                      <h2>E-Book Library</h2>
                      <p>Browse PDF books by course, year level, semester, and subject.</p>
                    </div>
                    {isAdmin && (
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <IonButton fill="outline" onClick={() => void addCourse()}>+ ADD COURSE</IonButton>
                        <IonButton fill="outline" color="danger" onClick={() => void deleteCourse()} disabled={!additionalCourses.length}>DELETE COURSE</IonButton>
                        <IonButton onClick={() => { setShowEbookUploadForm((show) => !show); setEbooksError(''); }} disabled={ebookUploading}>
                          {showEbookUploadForm ? 'Cancel' : '+ ADD E-BOOK'}
                        </IonButton>
                      </div>
                    )}
                  </div>

                  <input ref={ebookCoverInputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => void uploadEbookCover(event)} />
                  <input ref={ebookCollectionCoverInputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="Choose E-Book Collection photo" onChange={(event) => void uploadEbookCollectionCover(event)} />
                  {isAdmin && showEbookUploadForm && (
                    <div style={{ margin: '14px 0 18px', padding: 14, background: '#fff', border: '1px solid #dce3eb', borderRadius: 12 }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(135px, 1fr))', gap: 8, maxWidth: 520 }}>
                        <label style={{ fontSize: 12, fontWeight: 700, color: '#526174' }}>Course
                          <IonSelect value={ebookUploadCourse} onIonChange={(event) => { const value = String(event.detail.value || 'BSIT'); setEbookUploadCourse(value); setEbookUploadYear(value === 'BSIT' ? '1ST YEAR CICT' : `1ST YEAR ${value}`); setEbookUploadSemester(value === 'BSIT' ? '1st sem 1st yr cict' : '1st Semester'); setEbookUploadSubject(''); }} interface="popover" fill="outline" disabled={ebookUploading}>
                            {availableCourseOptions.map((courseOption) => <IonSelectOption key={courseOption.value} value={courseOption.value}>{courseOption.label}</IonSelectOption>)}
                          </IonSelect>
                        </label>
                        <label style={{ fontSize: 12, fontWeight: 700, color: '#526174' }}>Year level
                          <IonSelect value={ebookUploadYear} onIonChange={(event) => { const value = String(event.detail.value || '1ST YEAR'); setEbookUploadYear(value); setEbookUploadSemester(ebookUploadCourse === 'BSIT' ? `1st sem ${value.toLowerCase().replace(' year cict', ' yr cict')}` : '1st Semester'); setEbookUploadSubject(''); }} interface="popover" fill="outline" disabled={ebookUploading}>
                            {[1,2,3,4].map((year) => <IonSelectOption key={year} value={ebookUploadCourse === 'BSIT' ? `${year}${year === 1 ? 'ST' : year === 2 ? 'ND' : year === 3 ? 'RD' : 'TH'} YEAR CICT` : `${year}${year === 1 ? 'ST' : year === 2 ? 'ND' : year === 3 ? 'RD' : 'TH'} YEAR ${ebookUploadCourse}`}>{year}{year === 1 ? 'ST' : year === 2 ? 'ND' : year === 3 ? 'RD' : 'TH'} YEAR</IonSelectOption>)}
                          </IonSelect>
                        </label>
                        <label style={{ fontSize: 12, fontWeight: 700, color: '#526174' }}>Semester
                          <IonSelect value={ebookUploadSemester} onIonChange={(event) => { setEbookUploadSemester(String(event.detail.value || '1st Semester')); setEbookUploadSubject(''); }} interface="popover" fill="outline" disabled={ebookUploading}>
                            <IonSelectOption value={ebookUploadCourse === 'BSIT' ? `1st sem ${ebookUploadYear.toLowerCase().replace(' year cict',' yr cict')}` : '1st Semester'}>1st Semester</IonSelectOption>
                            <IonSelectOption value={ebookUploadCourse === 'BSIT' ? `2nd sem ${ebookUploadYear.toLowerCase().replace(' year cict',' yr cict')}` : '2nd Semester'}>2nd Semester</IonSelectOption>
                          </IonSelect>
                        </label>
                        <label style={{ fontSize: 12, fontWeight: 700, color: '#526174' }}>Subject / Course code
                          {getEbookSubjects(ebookUploadCourse, ebookUploadYear, String(ebookUploadSemester).toLowerCase().startsWith('1st') ? '1st Semester' : '2nd Semester').length > 0 ? (
                            <IonSelect value={ebookUploadSubject} placeholder="Select subject" onIonChange={(event) => setEbookUploadSubject(String(event.detail.value || ''))} interface="popover" fill="outline" disabled={ebookUploading}>
                              {getEbookSubjects(ebookUploadCourse, ebookUploadYear, String(ebookUploadSemester).toLowerCase().startsWith('1st') ? '1st Semester' : '2nd Semester').map((subject) => <IonSelectOption key={subject} value={subject}>{subject}</IonSelectOption>)}
                            </IonSelect>
                          ) : (
                            <IonInput value={ebookUploadSubject} placeholder="Enter subject or course code" onIonInput={(event) => setEbookUploadSubject(String(event.detail.value || ''))} fill="outline" disabled={ebookUploading} />
                          )}
                        </label>
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                        <IonButton onClick={() => ebookPdfInputRef.current?.click()} disabled={ebookUploading || !ebookUploadSubject.trim()}>{ebookUploading ? <IonSpinner name="crescent" /> : 'Upload PDFs'}</IonButton>
                        <IonButton fill="outline" color="medium" onClick={() => setShowEbookUploadForm(false)} disabled={ebookUploading}>Cancel</IonButton>
                      </div>
                      <p style={{ margin: '8px 0 0', color: '#64748b', fontSize: 12 }}>Select the course, year, semester, and subject before uploading. You can upload multiple PDF files into the same subject folder.</p>
                    </div>
                  )}
                  <input ref={ebookPdfInputRef} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(event) => void uploadEbookPdf(event)} />
                  <input ref={ebookZipInputRef} type="file" accept=".zip,application/zip,application/x-zip-compressed" hidden onChange={(event) => void importEbookZip(event)} />

                  {selectedEbook ? (
                    <div style={{ background: '#fff', border: '1px solid #dce3eb', borderRadius: 14, padding: 14 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                        <div style={{ minWidth: 0 }}><h3 style={{ margin: '0 0 4px', overflowWrap: 'anywhere' }}>{selectedEbook.title}</h3><small style={{ color: '#68778b' }}>{selectedEbook.folder_path || selectedEbook.category} · PDF</small></div>
                        <IonButton fill="outline" onClick={() => setSelectedEbook(null)}>Back to E-Books</IonButton>
                      </div>
                      <iframe title={`Read ${selectedEbook.title}`} src={`${API}${selectedEbook.preview_url}`} style={{ width: '100%', height: 'min(76vh, 900px)', minHeight: 480, border: '1px solid #dce3eb', borderRadius: 10, background: '#f4f6f8' }} allow="autoplay" />
                      <a href={`${API}${selectedEbook.preview_url}`} target="_blank" rel="noreferrer" style={{ color: '#1d5b86', fontWeight: 700 }}>Open PDF in a new tab</a>
                    </div>
                  ) : (
                    <>
                      {ebooksLoading && <div className="loading-row"><IonSpinner /><span>Loading uploaded PDF books…</span></div>}
                      {ebooksError && <div role="alert" style={{ padding: 14, margin: '12px 0', color: '#8a2b25', background: '#fff1ef', borderRadius: 10 }}>{ebooksError}</div>}
                      {!ebooksLoading && ebooks.length === 0 && <div className="research-empty-state"><strong>No PDF e-books found.</strong><p>Admin can upload PDFs and assign them to a course, year, semester, and subject.</p></div>}

                      {!selectedEbookCourse && (
                        <div className="research-course-cards" aria-label="Choose an e-book course collection">
                          {availableCourseOptions.map((courseOption, index) => {
                            const count = ebooks.filter((item) => (item.course || item.category || '').toUpperCase() === courseOption.value).length;
                            const courseCode = courseOption.value.toUpperCase();
                            const isBuiltInEbookCourse = ['BSIT', 'BSBA', 'BSED'].includes(courseCode);
                            const defaultCover = isBuiltInEbookCourse ? `/images/ebook-${courseCode.toLowerCase()}.jpeg` : null;
                            const coverSrc = ebookCollectionCovers[courseCode] || defaultCover;
                            return <div className="research-course-card-shell" key={courseOption.value} style={{ position: 'relative', minWidth: 0 }}>
                              <button type="button" className={`research-course-card research-course-card-${index + 1}`} style={{ width: '100%' }} onClick={() => { setSelectedEbookCourse(courseOption.value); setSelectedEbookYear(null); setSelectedEbookSemester(null); setSelectedEbookSubject(null); setEbookQuery(''); }}>
                                <div className="research-course-cover" style={{ position: 'relative', overflow: 'hidden', width: '100%', height: 'auto', aspectRatio: '1 / 1', padding: 0, margin: 0, boxSizing: 'border-box', borderRadius: 18, background: coverSrc ? 'transparent' : 'linear-gradient(145deg, #102b4e 0%, #1d5b86 58%, #d5a642 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                  {coverSrc ? (
                                    <img src={coverSrc} alt={`${courseOption.shortName} e-books collection cover`} loading="lazy" style={{ position: 'absolute', inset: 0, display: 'block', width: '100%', height: '100%', maxWidth: 'none', objectFit: 'cover', objectPosition: 'center', padding: 0, margin: 0, borderRadius: 'inherit' }} />
                                  ) : (
                                    <div aria-label={`${courseCode} default course cover`} style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: '#fff', textAlign: 'center', padding: 16 }}>
                                      <span style={{ fontSize: 'clamp(28px, 7vw, 54px)', lineHeight: 1, fontWeight: 900, letterSpacing: 1.5 }}>{courseCode}</span>
                                      <span style={{ width: 52, height: 3, borderRadius: 99, background: '#e4b84f' }} />
                                      <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 3 }}>LIBTRACK E-BOOKS</span>
                                    </div>
                                  )}
                                </div>
                                <div className="research-course-card-info"><span className="research-course-category">E-BOOK COLLECTION</span><strong>{courseOption.label}</strong><div className="research-course-card-footer"><span className="research-count-pill">{count} {count === 1 ? 'e-book' : 'e-books'}</span><span>Open collection →</span></div></div>
                              </button>
                              {isAdmin && <IonButton size="small" fill="solid" color="light" disabled={ebookCollectionCoverUploading === courseCode} onClick={() => chooseEbookCollectionCover(courseCode)} style={{ position: 'absolute', top: 12, right: 12, zIndex: 3, '--border-radius': '10px', fontWeight: 700 }}>{ebookCollectionCoverUploading === courseCode ? 'Uploading…' : 'Edit Photo'}</IonButton>}
                            </div>;
                          })}
                        </div>
                      )}

                      {selectedEbookCourse && (() => {
                        const courseBooks = ebooks.filter((item) => (item.course || item.category || '').toUpperCase() === selectedEbookCourse);
                        // Always show all four year levels, even before PDFs are uploaded.
                        // Folder values match the metadata saved by the admin upload form.
                        const yearFolders = [1, 2, 3, 4].map((year) =>
                          selectedEbookCourse === 'BSIT'
                            ? `${year}${year === 1 ? 'ST' : year === 2 ? 'ND' : year === 3 ? 'RD' : 'TH'} YEAR CICT`
                            : `${year}${year === 1 ? 'ST' : year === 2 ? 'ND' : year === 3 ? 'RD' : 'TH'} YEAR ${selectedEbookCourse}`
                        );
                        const semesterBooks = selectedEbookYear ? courseBooks.filter((item) => (item.year || 'Unsorted') === selectedEbookYear) : [];
                        // Show both semesters for every year; counts can be zero until files are added.
                        const semesterFolders = selectedEbookCourse === 'BSIT'
                          ? [
                              { value: `1st sem ${String(selectedEbookYear || '').toLowerCase().replace(' year cict', ' yr cict')}`, label: '1st Semester' },
                              { value: `2nd sem ${String(selectedEbookYear || '').toLowerCase().replace(' year cict', ' yr cict')}`, label: '2nd Semester' },
                            ]
                          : [
                              { value: '1st Semester', label: '1st Semester' },
                              { value: '2nd Semester', label: '2nd Semester' },
                            ];
                        const semesterDisplayName = selectedEbookSemester
                          ? (String(selectedEbookSemester).toLowerCase().startsWith('1st') ? '1st Semester' : '2nd Semester')
                          : '';
                        const subjectBooks = selectedEbookSemester ? semesterBooks.filter((item) => (item.semester || 'Unsorted') === selectedEbookSemester) : [];
                        const subjectFolders = ['BSIT', 'BSBA', 'BSED'].includes(selectedEbookCourse) && selectedEbookYear && selectedEbookSemester
                          ? getEbookSubjects(selectedEbookCourse, selectedEbookYear, String(selectedEbookSemester).toLowerCase().startsWith('1st') ? '1st Semester' : '2nd Semester')
                          : Array.from(new Set(subjectBooks.map((item) => item.subject || 'General'))).sort();
                        const folderButton = (name: string, count: number, onClick: () => void) => <button type="button" onClick={onClick} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, width: '100%', padding: '17px 19px', border: '1px solid #dce3eb', borderRadius: 13, background: '#fff', color: '#203047', textAlign: 'left', cursor: 'pointer', boxShadow: '0 3px 12px rgba(24,45,70,.05)' }}><span style={{ display: 'flex', alignItems: 'center', gap: 12 }}><span style={{ fontSize: 25 }}>📁</span><strong>{name}</strong></span><span style={{ color: '#718096', fontSize: 13 }}>{count} {count === 1 ? 'PDF' : 'PDFs'}　→</span></button>;
                        const visiblePdfBooks = selectedEbookSubject ? subjectBooks.filter((item) => (item.subject || 'General') === selectedEbookSubject && `${item.title} ${item.file_name}`.toLowerCase().includes(ebookQuery.trim().toLowerCase())) : [];
                        return <section className="research-selected-course research-course-page">
                          <div className="research-subpage-topbar"><IonButton fill="outline" onClick={() => { if (selectedEbookSubject) setSelectedEbookSubject(null); else if (selectedEbookSemester) setSelectedEbookSemester(null); else if (selectedEbookYear) setSelectedEbookYear(null); else setSelectedEbookCourse(null); setEbookQuery(''); }}>← Back</IonButton><span className="eyebrow">E-BOOK FOLDERS</span></div>
                          <div className="research-selected-heading"><div><h3>{selectedEbookSubject || semesterDisplayName || selectedEbookYear || selectedEbookCourse}</h3>{selectedEbookSubject && <p className="research-page-description">PDF books in this subject folder.</p>}</div></div>
                          <nav aria-label="E-book folder path" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 9, rowGap: 5, margin: '10px 0 16px', color: '#718096', fontSize: 14, lineHeight: 1.5 }}>
                            <button type="button" onClick={() => { setSelectedEbookCourse(null); setSelectedEbookYear(null); setSelectedEbookSemester(null); setSelectedEbookSubject(null); }} style={{ border: 0, padding: 0, background: 'none', color: '#1d5b86', cursor: 'pointer', font: 'inherit' }}>{selectedEbookCourse}</button>
                            {selectedEbookYear && <><span aria-hidden="true">/</span><button type="button" onClick={() => { setSelectedEbookSemester(null); setSelectedEbookSubject(null); }} style={{ border: 0, padding: 0, background: 'none', color: '#1d5b86', cursor: 'pointer', font: 'inherit' }}>{selectedEbookCourse === 'BSIT' ? selectedEbookYear.replace(/\s+CICT$/i, ' BSIT') : selectedEbookYear}</button></>}
                            {selectedEbookSemester && <><span aria-hidden="true">/</span><button type="button" onClick={() => setSelectedEbookSubject(null)} style={{ border: 0, padding: 0, background: 'none', color: '#1d5b86', cursor: 'pointer', font: 'inherit' }}>{semesterDisplayName}</button></>}
                            {selectedEbookSubject && <><span aria-hidden="true">/</span><span>{selectedEbookSubject}</span></>}
                          </nav>
                          {!selectedEbookYear && <div style={{ display: 'grid', gap: 10 }}>{yearFolders.map((folder) => folderButton(folder, courseBooks.filter((item) => (item.year || 'Unsorted') === folder).length, () => setSelectedEbookYear(folder)))}</div>}
                          {selectedEbookYear && !selectedEbookSemester && <div style={{ display: 'grid', gap: 10 }}>{semesterFolders.map((folder) => folderButton(folder.label, semesterBooks.filter((item) => (item.semester || 'Unsorted') === folder.value).length, () => setSelectedEbookSemester(folder.value)))}</div>}
                          {selectedEbookSemester && !selectedEbookSubject && <div style={{ display: 'grid', gap: 10 }}>{subjectFolders.map((folder) => folderButton(folder, subjectBooks.filter((item) => (item.subject || 'General') === folder).length, () => setSelectedEbookSubject(folder)))}</div>}
                          {selectedEbookSubject && <><IonSearchbar value={ebookQuery} onIonInput={(event) => setEbookQuery(event.detail.value || '')} placeholder="Search PDF title…" debounce={0} />{visiblePdfBooks.length ? <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 240px), 1fr))', alignItems: 'stretch', gap: 16, marginTop: 12 }}>{visiblePdfBooks.map((item) => <article key={item.id} style={{ height: 390, minHeight: 390, minWidth: 0, display: 'flex', flexDirection: 'column', background: '#fff', border: '1px solid #dce3eb', borderRadius: 16, overflow: 'hidden', boxShadow: '0 3px 12px rgba(24,45,70,.06)' }}><div style={{ height: 204, minHeight: 204, flex: '0 0 204px', background: 'linear-gradient(145deg,#eaf0f5,#d7e1eb)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>{item.thumbnail_url ? <img src={item.thumbnail_url.startsWith('http') ? item.thumbnail_url : `${API}${item.thumbnail_url}`} alt={`Cover for ${item.title}`} style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : <span style={{ fontSize: 50 }}>📕</span>}</div><div style={{ padding: 16, flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}><h3 style={{ margin: '0 0 12px', minHeight: 81, maxHeight: 81, fontSize: 17, lineHeight: 1.35, fontWeight: 600, overflowWrap: 'anywhere', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 4, overflow: 'hidden' }}>{item.title}</h3>{!isAdmin && <IonButton expand="block" style={{ marginTop: 'auto' }} onClick={() => setSelectedEbook(item)}>Read E-Book</IonButton>}{isAdmin && <><IonButton expand="block" fill="outline" style={{ marginTop: 'auto' }} disabled={ebookCoverUploadingId === item.id} onClick={() => chooseEbookCover(item)}>{ebookCoverUploadingId === item.id ? 'Uploading cover…' : item.thumbnail_url ? 'Change Cover' : 'Add Cover'}</IonButton><IonButton expand="block" fill="outline" color="danger" style={{ marginTop: 8 }} onClick={() => void deleteEbook(item)}>Delete E-Book</IonButton></>}</div></article>)}</div> : <div className="research-empty-state"><strong>No PDFs in this subject folder.</strong></div>}</>}
                        </section>;
                      })()}
                    </>
                  )}
                </section>
              )}

              {/* RESEARCH LIBRARY */}
              {page === 'research' && (
                <section className={`research-library-page research-view-${researchView}`}>
                  <input ref={researchCollectionCoverInputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="Choose Research Collection photo" onChange={(event) => void uploadResearchCollectionCover(event)} />
                  <input
                    ref={researchPdfInputRef}
                    type="file"
                    accept="application/pdf,.pdf"
                    hidden
                    aria-label="Choose a research PDF"
                    onChange={(event) => void uploadResearchPdf(event)}
                  />

                  <div className="section-heading research-heading">
                    <div>
                      <span className="eyebrow">NEUST PEÑARANDA OFF-CAMPUS</span>
                      <h2>Research Library</h2>
                      <p>Browse campus research and capstone records. Search by course, type, title, author, or source. Only mark a record Verified after checking its original source.</p>
                    </div>
                    <IonBadge color="primary">{researchItems.length} resources</IonBadge>
                  </div>

                  {researchView !== 'reader' && (
                    <div className="research-top-search">
                      <IonSearchbar
                        value={researchQuery}
                        onIonInput={(event) => setResearchQuery(event.detail.value || '')}
                        placeholder={researchView === 'course' ? 'Search this course research…' : 'Search research title, author, subject, course, or source…'}
                        debounce={0}
                        aria-label="Search Research Library"
                      />
                    </div>
                  )}

                  {isAdmin && researchView === 'collections' && (
                    <div className="research-admin-tools">
                      <p><strong>Manage Research</strong><br /><small>Add actual Peñaranda Off-Campus research, BSIT capstones, or faculty research. Mark records Verified only after checking the original document. Do not enter invented titles or authors.</small></p>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><IonButton fill="outline" onClick={() => void addCourse()}>+ Add Course</IonButton><IonButton fill="outline" color="danger" onClick={() => void deleteCourse()} disabled={!additionalCourses.length}>Delete Course</IonButton><IonButton onClick={() => void saveResearch()}>+ Add Research</IonButton></div>
                    </div>
                  )}

                  {researchLoading && <div className="research-loading-state"><IonSpinner /><span>Loading research collection…</span></div>}

                  {researchView === 'collections' && (
                    researchQuery.trim() ? (
                      <div className="research-search-page">
                        <div className="research-subpage-heading">
                          <div><span className="eyebrow">SEARCH RESULTS</span><h3>Matching Research</h3></div>
                          <span className="research-count-pill">
                            {researchItems.filter((item) => `${item.title} ${item.authors} ${item.subject} ${item.course} ${item.campus} ${item.note || ''}`.toLowerCase().includes(researchQuery.trim().toLowerCase())).length} results
                          </span>
                        </div>
                        {(() => {
                          const term = researchQuery.trim().toLowerCase();
                          const matches = researchItems.filter((item) => `${item.title} ${item.authors} ${item.subject} ${item.course} ${item.campus} ${item.note || ''}`.toLowerCase().includes(term));
                          if (!matches.length) return <div className="research-empty-state"><strong>No matching research found.</strong><p>Try a different title, author, subject, or course.</p></div>;
                          return (
                            <div className="research-results research-global-results" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '14px' }}>
                              {matches.map((item) => (
                                <div className="research-result-row" key={item.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '10px', padding: '16px 18px', border: '1px solid #dbe4ef', borderRadius: '14px', background: '#ffffff', boxShadow: '0 2px 8px rgba(20, 43, 70, 0.05)', minWidth: 0 }}>
                                  <button type="button" className="research-result" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '7px', width: '100%', minWidth: 0, padding: '0', border: 0, background: 'transparent', color: '#17324f', textAlign: 'left', cursor: 'pointer', whiteSpace: 'normal', overflowWrap: 'anywhere' }} onClick={() => { setSelectedResearchCourse(getResearchCollectionKey(item.course)); setSelectedResearchId(item.id); setResearchView('reader'); }}>
                                    <strong style={{ fontSize: '16px', lineHeight: 1.45, fontWeight: 750, overflowWrap: 'anywhere' }}>{item.title}</strong>
                                    <span style={{ fontSize: '13px', lineHeight: 1.45, color: '#9a6a08', fontWeight: 650, overflowWrap: 'anywhere' }}>{item.research_type || 'Research Paper'} · {item.subject} · {getResearchCollectionKey(item.course)}</span>
                                    <small style={{ fontSize: '12px', lineHeight: 1.5, color: '#64748b', overflowWrap: 'anywhere' }}>{item.authors} · {item.year}{item.teacher ? ` · Teacher: ${item.teacher}` : ''} · {item.campus}</small>
                                    {item.has_pdf && <small className="research-pdf-status">✓ Full-text PDF available</small>}
                                  </button>
                                  {isAdmin && <div className="research-item-actions"><IonButton size="small" fill="clear" onClick={() => void saveResearch(item)}>Edit</IonButton><IonButton size="small" fill="outline" disabled={pdfUploadingResearchId === item.id} onClick={() => chooseResearchPdfUpload(item)}>{pdfUploadingResearchId === item.id ? 'Uploading…' : item.has_pdf ? 'Replace PDF' : 'Upload PDF'}</IonButton><IonButton size="small" color="danger" fill="clear" onClick={() => void deleteResearch(item)}>Delete</IonButton></div>}
                                </div>
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                    ) : (
                      <div className="research-course-cards" aria-label="Choose a course">
                        {availableCourseOptions.map((courseOption, index) => {
                          const courseName = courseOption.value;
                          const count = researchItems.filter((item) => getResearchCollectionKey(item.course) === getResearchCollectionKey(courseName)).length;
                          const courseCode = courseName.toUpperCase();
                          const isBuiltInCollection = ['BSIT', 'BSBA', 'BSED'].includes(courseCode);
                          // Newly added course collections start with an empty cover.
                          // Only the built-in courses use the bundled default artwork.
                          const defaultCover = isBuiltInCollection ? `/images/research-${courseCode.toLowerCase()}.jpeg` : null;
                          const coverSrc = researchCollectionCovers[courseCode] || defaultCover;
                          return (
                            <div className="research-course-card-shell" key={courseName} style={{ position: 'relative', minWidth: 0 }}>
                              <button
                                type="button"
                                className={`research-course-card research-course-card-${index + 1}`}
                                style={{ width: '100%' }}
                                onClick={() => { setSelectedResearchCourse(courseName); setSelectedResearchId(null); setResearchQuery(''); setResearchView('course'); }}
                              >
                                <div className="research-course-cover" style={{ position: 'relative', overflow: 'hidden', width: '100%', height: 'auto', aspectRatio: '1 / 1', padding: 0, margin: 0, boxSizing: 'border-box', borderRadius: 18, background: coverSrc ? 'transparent' : 'linear-gradient(145deg, #102b4e 0%, #1d5b86 58%, #d5a642 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                  {coverSrc ? (
                                    <img
                                      src={coverSrc}
                                      alt={`${courseOption.shortName} research collection cover`}
                                      loading="lazy"
                                      style={{ position: 'absolute', inset: 0, display: 'block', width: '100%', height: '100%', maxWidth: 'none', objectFit: 'cover', objectPosition: 'center', padding: 0, margin: 0, borderRadius: 'inherit' }}
                                    />
                                  ) : (
                                    <div aria-label={`${courseCode} default course cover`} style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: '#fff', textAlign: 'center', padding: 16 }}>
                                      <span style={{ fontSize: 'clamp(28px, 7vw, 54px)', lineHeight: 1, fontWeight: 900, letterSpacing: 1.5 }}>{courseCode}</span>
                                      <span style={{ width: 52, height: 3, borderRadius: 99, background: '#e4b84f' }} />
                                      <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 3 }}>LIBTRACK RESEARCH</span>
                                    </div>
                                  )}
                                </div>
                                <div className="research-course-card-info">
                                  <span className="research-course-category">RESEARCH COLLECTION</span>
                                  <strong>{courseOption.label}</strong>
                                  <span className="research-course-subtitle">{courseOption.description}</span>
                                  <div className="research-course-card-footer"><span className="research-count-pill">{count} {count === 1 ? 'research' : 'researches'}</span><span>Open collection →</span></div>
                                </div>
                              </button>
                              {isAdmin && (
                                <IonButton
                                  size="small"
                                  fill="solid"
                                  color="light"
                                  disabled={researchCollectionCoverUploading === courseCode}
                                  onClick={() => chooseResearchCollectionCover(courseCode)}
                                  style={{ position: 'absolute', top: 12, right: 12, zIndex: 3, '--border-radius': '10px', fontWeight: 700 }}
                                >
                                  {researchCollectionCoverUploading === courseCode ? 'Uploading…' : 'Edit Photo'}
                                </IonButton>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )
                  )}

                  {researchView === 'course' && selectedResearchCourse && (
                    <section className="research-selected-course research-course-page">
                      <div className="research-subpage-topbar">
                        <IonButton fill="outline" onClick={() => { setResearchView('collections'); setResearchQuery(''); setSelectedResearchId(null); }}>← All Courses</IonButton>
                        <span className="eyebrow">COURSE COLLECTION</span>
                      </div>
                      <div className="research-selected-heading">
                        <div>
                          <h3>{RESEARCH_COURSE_OPTIONS.find((option) => option.value === selectedResearchCourse)?.label || selectedResearchCourse} Research</h3>
                          <p className="research-page-description">Select a research title to open its full details and reader on a separate page.</p>
                        </div>
                        <span className="research-count-pill">{researchItems.filter((item) => getResearchCollectionKey(item.course) === getResearchCollectionKey(selectedResearchCourse) && `${item.title} ${item.authors} ${item.subject} ${item.course} ${item.campus} ${item.note || ''}`.toLowerCase().includes(researchQuery.trim().toLowerCase())).length} results</span>
                      </div>
                      {(() => {
                        const allCourseItems = researchItems.filter((item) => getResearchCollectionKey(item.course) === getResearchCollectionKey(selectedResearchCourse));
                        const term = researchQuery.trim().toLowerCase();
                        const courseItems = allCourseItems.filter((item) => `${item.title} ${item.authors} ${item.subject} ${item.course} ${item.campus} ${item.note || ''}`.toLowerCase().includes(term));
                        if (courseItems.length === 0) return <div className="research-empty-state"><strong>{allCourseItems.length ? 'No matching research found.' : `No research is available yet for ${selectedResearchCourse}.`}</strong><p>Research added for this course will appear here.</p></div>;
                        return (
                          <div className="research-results research-course-results" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '14px' }}>
                            {courseItems.map((item) => (
                              <div className="research-result-row" key={item.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '10px', padding: '16px 18px', border: '1px solid #dbe4ef', borderRadius: '14px', background: '#ffffff', boxShadow: '0 2px 8px rgba(20, 43, 70, 0.05)', minWidth: 0 }}>
                                <button type="button" className="research-result" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '7px', width: '100%', minWidth: 0, padding: '0', border: 0, background: 'transparent', color: '#17324f', textAlign: 'left', cursor: 'pointer', whiteSpace: 'normal', overflowWrap: 'anywhere' }} onClick={() => { setSelectedResearchId(item.id); setResearchView('reader'); }}>
                                    <strong style={{ fontSize: '16px', lineHeight: 1.45, fontWeight: 750, overflowWrap: 'anywhere' }}>{item.title}</strong>
                                  <span style={{ fontSize: '13px', lineHeight: 1.45, color: '#9a6a08', fontWeight: 650, overflowWrap: 'anywhere' }}>{item.subject}</span>
                                  <small style={{ fontSize: '12px', lineHeight: 1.5, color: '#64748b', overflowWrap: 'anywhere' }}>{item.authors} · {item.year}{item.teacher ? ` · Teacher: ${item.teacher}` : ''}</small>
                                  <small style={{ fontSize: '12px', lineHeight: 1.5, color: '#64748b', overflowWrap: 'anywhere' }}>{item.campus}</small>
                                  {item.has_pdf && <small className="research-pdf-status">✓ Full-text PDF available</small>}
                                </button>
                                {isAdmin && <div className="research-item-actions"><IonButton size="small" fill="clear" onClick={() => void saveResearch(item)}>Edit</IonButton><IonButton size="small" fill="outline" disabled={pdfUploadingResearchId === item.id} onClick={() => chooseResearchPdfUpload(item)}>{pdfUploadingResearchId === item.id ? 'Uploading…' : item.has_pdf ? 'Replace PDF' : 'Upload PDF'}</IonButton><IonButton size="small" color="danger" fill="clear" onClick={() => void deleteResearch(item)}>Delete</IonButton></div>}
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                    </section>
                  )}

                  {researchView === 'reader' && (
                    (() => {
                      const selected = researchItems.find((item) => item.id === selectedResearchId);
                      if (!selected) {
                        return <div className="research-empty-state"><strong>The selected research could not be found.</strong><p>Return to the collection and select a research item again.</p><IonButton fill="outline" onClick={() => setResearchView(selectedResearchCourse ? 'course' : 'collections')}>← Back to Research</IonButton></div>;
                      }
                      const selectedCollectionKey = getResearchCollectionKey(selected.course);
                      const selectedCourseOption = RESEARCH_COURSE_OPTIONS.find((option) => getResearchCollectionKey(option.value) === selectedCollectionKey);
                      return (
                        <section className="research-reader-page">
                          <div className="research-reader-page-topbar">
                            <IonButton fill="outline" onClick={() => { setSelectedResearchCourse(getResearchCollectionKey(selected.course)); setResearchView('course'); }}>← Back to {selectedCourseOption?.shortName || selected.course}</IonButton>
                            <span className="eyebrow">FULL RESEARCH READER</span>
                          </div>
                          <article className="research-reader-panel research-reader-page-panel">
                            <div className="research-meta">
                              <span className="eyebrow">{getResearchCollectionKey(selected.course)} · {selected.subject} · FULL-TEXT READER</span>
                              <h3>{selected.title}</h3>
                              <p><strong>Authors:</strong> {selected.authors}</p>
                              {selected.teacher && <p><strong>Research Teacher / Adviser:</strong> {selected.teacher}</p>}
                              <p><strong>Year:</strong> {selected.year}</p>
                              <p><strong>Source / campus:</strong> {selected.campus}</p>
                              {selected.verification_status && <p><strong>Source status:</strong> {selected.verification_status}</p>}
                              {selected.abstract && <div className="research-source-note"><strong>Abstract / Summary</strong><p>{selected.abstract}</p></div>}
                              {selected.note && <div className="research-source-note"><strong>Research overview / notes</strong><p>{selected.note}</p></div>}
                              {selected.has_pdf && selected.pdf_url ? (
                                <a className="research-open-link" href={`${API}${selected.pdf_url}`} target="_blank" rel="noreferrer">Open uploaded full-text PDF ↗</a>
                              ) : selected.url ? (
                                <a className="research-open-link" href={selected.url} target="_blank" rel="noreferrer">Open original paper / source ↗</a>
                              ) : (
                                <p className="research-reader-help">No full-text PDF or external source link is attached yet.</p>
                              )}
                              {isAdmin && (
                                <div className="research-reader-admin-action">
                                  <IonButton size="small" fill="outline" onClick={() => void saveResearch(selected)}>Edit Details</IonButton>
                                  <IonButton size="small" fill="outline" disabled={pdfUploadingResearchId === selected.id} onClick={() => chooseResearchPdfUpload(selected)}>{pdfUploadingResearchId === selected.id ? 'Uploading PDF…' : selected.has_pdf ? 'Replace PDF' : 'Upload PDF'}</IonButton>
                                  <IonButton size="small" color="danger" fill="clear" onClick={() => void deleteResearch(selected)}>Delete Research</IonButton>
                                </div>
                              )}
                            </div>
                            <div className="research-pdf-frame research-reader-page-frame">
                              {selected.has_pdf && selected.pdf_url ? (
                                <iframe key={`uploaded-${selected.id}`} src={`${API}${selected.pdf_url}#toolbar=0&navpanes=0&view=FitH`} title={`Read uploaded PDF: ${selected.title}`} loading="lazy" />
                              ) : selected.url ? (
                                <iframe key={`external-${selected.id}`} src={selected.url} title={`Read ${selected.title}`} loading="lazy" />
                              ) : (
                                <div className="research-pdf-placeholder"><strong>No full-text PDF yet</strong><p>{isAdmin ? 'Select “Upload PDF” to add the full research document to the reader.' : 'The administrator has not uploaded the full research PDF yet.'}</p></div>
                              )}
                            </div>
                            <small className="research-reader-help">{selected.has_pdf ? 'The PDF uploaded to LibTrack is embedded here so it can be read within the app.' : selected.url ? 'The original source is embedded here. Some websites may block embedding; use the source link if it does not appear.' : 'Only admins can upload PDFs. PDFs up to 25 MB are accepted.'}</small>
                          </article>
                        </section>
                      );
                    })()
                  )}
                </section>
              )}

              {/* BORROWING ACTIVITY */}

              {/* ADMIN INVENTORY: BOOKS, RESEARCH, AND E-BOOKS */}
              {page === 'borrowingStats' && isAdmin && (
                <section className="inventory-page" style={{ maxWidth: 1440, margin: '0 auto', padding: '8px 4px 40px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 18, flexWrap: 'wrap', marginBottom: 24 }}>
                    <div>
                      <span className="eyebrow">REPORTS AND ANALYTICS</span>
                      <h2 style={{ margin: '7px 0 6px', fontSize: 30, lineHeight: 1.2, fontWeight: 800, color: '#17324d' }}>Borrowing Statistics</h2>
                      <p style={{ margin: 0, color: '#718096', fontSize: 14, lineHeight: 1.5 }}>Actual borrowing transactions by department for A.Y. 2026–2027. Mid-Year is excluded.</p>
                    </div>
                    <IonButton fill="outline" disabled={borrowingStatsLoading} onClick={async () => {
                      setBorrowingStatsLoading(true); setBorrowingStatsError('');
                      try {
                        const response = await fetch(`${API}/reports/borrowing-statistics?academic_year=2026-2027`, { headers: { Authorization: `Bearer ${token}` } });
                        setBorrowingStats(await readResponse(response));
                      } catch (error: any) { setBorrowingStatsError(error?.message || 'Unable to refresh statistics.'); }
                      finally { setBorrowingStatsLoading(false); }
                    }}>{borrowingStatsLoading ? <IonSpinner name="crescent" /> : '↻ Refresh'}</IonButton>
                  </div>

                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '0 0 24px' }}>
                    {([['all', 'All Semesters'], ['1st', '1st Semester'], ['2nd', '2nd Semester']] as const).map(([value, label]) =>
                      <IonButton key={value} size="small" fill={borrowingStatsSemester === value ? 'solid' : 'outline'} onClick={() => setBorrowingStatsSemester(value)}>{label}</IonButton>)}
                  </div>

                  {borrowingStatsError && <IonText color="danger"><p role="alert">{borrowingStatsError}</p></IonText>}
                  {borrowingStatsLoading && !borrowingStats && <div className="empty-state"><IonSpinner name="crescent" /><p>Loading borrowing statistics...</p></div>}
                  {borrowingStats && (() => {
                    const semesters = borrowingStatsSemester === 'all' ? borrowingStats.semesters : borrowingStats.semesters.filter((item: any) => item.key === borrowingStatsSemester);
                    const rows = ['BSIT', 'BSED', 'BSBA'].map(department => ({ department, total: semesters.reduce((sum: number, semester: any) => sum + (semester.departments?.[department]?.total || 0), 0) }));
                    const grandTotal = rows.reduce((sum, row) => sum + row.total, 0);
                    const maxValue = Math.max(1, ...rows.map(row => row.total));
                    const kpiStyle: React.CSSProperties = { background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 16, padding: '20px 22px', minWidth: 0, boxShadow: '0 3px 12px rgba(20, 45, 70, .05)' };
                    return <>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 16, marginBottom: 24 }}>
                        <article style={{ ...kpiStyle, borderTop: '4px solid #d8a52b' }}>
                          <span style={{ display: 'block', color: '#718096', fontSize: 13, fontWeight: 700, marginBottom: 9 }}>TOTAL BORROWINGS</span>
                          <strong style={{ display: 'block', color: '#17324d', fontSize: 32, lineHeight: 1.1 }}>{grandTotal.toLocaleString()}</strong>
                          <small style={{ display: 'block', color: '#8492a6', marginTop: 8 }}>Approved borrowing transactions</small>
                        </article>
                        {rows.map(row => <article key={row.department} style={kpiStyle}>
                          <span style={{ display: 'block', color: '#718096', fontSize: 13, fontWeight: 700, marginBottom: 9 }}>{row.department}</span>
                          <strong style={{ display: 'block', color: '#17324d', fontSize: 32, lineHeight: 1.1 }}>{row.total.toLocaleString()}</strong>
                          <small style={{ display: 'block', color: '#8492a6', marginTop: 8 }}>Borrowing transactions</small>
                        </article>)}
                      </div>

                      <section style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 16, padding: '22px 24px', marginBottom: 24, boxShadow: '0 3px 12px rgba(20, 45, 70, .04)' }}>
                        <h3 style={{ margin: '0 0 5px', color: '#17324d', fontSize: 20, fontWeight: 750 }}>Borrowings per Department</h3>
                        <p style={{ margin: '0 0 22px', color: '#8492a6', fontSize: 13 }}>Comparison of total borrowing transactions for each department.</p>
                        {rows.map(row => (
                          <div key={row.department} style={{ margin: '0 0 20px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                              <strong style={{ color: '#243b53', fontSize: 14 }}>{row.department}</strong>
                              <strong style={{ color: '#17324d', fontSize: 14, fontVariantNumeric: 'tabular-nums' }}>{row.total.toLocaleString()}</strong>
                            </div>
                            <div style={{ height: 12, borderRadius: 99, background: '#edf1f5', overflow: 'hidden' }}>
                              <div style={{ height: '100%', width: `${row.total / maxValue * 100}%`, borderRadius: 99, background: 'linear-gradient(90deg, #d5a126, #f0c75c)', transition: 'width .25s ease' }} />
                            </div>
                          </div>
                        ))}
                      </section>

                      <section style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 16, padding: '22px 24px', boxShadow: '0 3px 12px rgba(20, 45, 70, .04)' }}>
                        <h3 style={{ margin: '0 0 18px', color: '#17324d', fontSize: 20, fontWeight: 750 }}>Semester Breakdown</h3>
                        {semesters.map((semester: any) => <div key={semester.key} style={{ marginTop: 18, paddingTop: 18, borderTop: '1px solid #edf1f5' }}>
                          <h4 style={{ margin: '0 0 5px', color: '#243b53', fontSize: 17, fontWeight: 750 }}>{semester.label}</h4>
                          <p style={{ margin: '0 0 14px', color: '#8492a6', fontSize: 13 }}>{semester.date_range}</p>
                          <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 460, fontSize: 14 }}>
                              <thead><tr style={{ background: '#f5f7fa' }}>
                                <th style={{ textAlign: 'left', padding: '12px 14px', color: '#526579', fontWeight: 700 }}>Department</th>
                                <th style={{ textAlign: 'right', padding: '12px 14px', color: '#526579', fontWeight: 700 }}>Borrowings</th>
                                <th style={{ textAlign: 'right', padding: '12px 14px', color: '#526579', fontWeight: 700 }}>Unique Books</th>
                              </tr></thead>
                              <tbody>{['BSIT', 'BSED', 'BSBA'].map((department: string) => {
                                const item = semester.departments?.[department] || { total: 0, unique_books: 0 };
                                return <tr key={department} style={{ borderBottom: '1px solid #edf1f5' }}>
                                  <td style={{ padding: '12px 14px', color: '#243b53', fontWeight: 650 }}>{department}</td>
                                  <td style={{ padding: '12px 14px', textAlign: 'right', color: '#243b53', fontVariantNumeric: 'tabular-nums' }}>{item.total}</td>
                                  <td style={{ padding: '12px 14px', textAlign: 'right', color: '#243b53', fontVariantNumeric: 'tabular-nums' }}>{item.unique_books}</td>
                                </tr>;
                              })}</tbody>
                            </table>
                          </div>
                          <h5 style={{ margin: '18px 0 9px', color: '#243b53', fontSize: 14, fontWeight: 750 }}>Most Borrowed Books</h5>
                          {(semester.top_books || []).length
                            ? <ol style={{ margin: 0, paddingLeft: 22, color: '#526579', lineHeight: 1.9 }}>{semester.top_books.map((book: any, index: number) => <li key={`${book.title}-${index}`}>{book.title} <strong style={{ color: '#17324d' }}>— {book.total} borrowings</strong></li>)}</ol>
                            : <p style={{ color: '#8492a6', fontSize: 13 }}>No borrowing records for this semester.</p>}
                        </div>)}
                      </section>
                    </>;
                  })()}
                  {!borrowingStatsLoading && !borrowingStats && !borrowingStatsError && <div className="empty-state"><p>No statistics available yet.</p></div>}
                </section>
              )}

              {page === 'inventory' && isAdmin && (
                <section className="inventory-page">
                  <div className="inventory-heading">
                    <div>
                      <span className="eyebrow">COLLECTION MANAGEMENT</span>
                      <h2>Library Inventory</h2>
                      <p>Complete records for physical books, research materials, and digital books.</p>
                    </div>
                    <div className="inventory-actions">
                      <IonButton fill="outline" onClick={() => void loadInventory()} disabled={inventoryLoading}>
                        {inventoryLoading ? <IonSpinner name="crescent" /> : '↻ Refresh'}
                      </IonButton>
                      <IonButton className="gold-button" onClick={exportInventoryCsv} disabled={inventoryLoading}>
                        ↓ Export Excel (CSV)
                      </IonButton>
                    </div>
                  </div>

                  <div className="inventory-summary-grid">
                    <button type="button" className={`inventory-summary-card ${inventoryTab === 'books' ? 'active' : ''}`} onClick={() => { setInventoryTab('books'); setInventoryQuery(''); }}>
                      <span className="inventory-summary-icon">📚</span>
                      <span><small>Physical book titles</small><strong>{books.length}</strong><em>{books.reduce((sum, item) => sum + (Number(item.total_copies) || 0), 0)} total copies</em></span>
                    </button>
                    <button type="button" className={`inventory-summary-card ${inventoryTab === 'research' ? 'active' : ''}`} onClick={() => { setInventoryTab('research'); setInventoryQuery(''); }}>
                      <span className="inventory-summary-icon">📄</span>
                      <span><small>Research materials</small><strong>{researchItems.length}</strong><em>{researchItems.filter((item) => item.has_pdf).length} with PDF file</em></span>
                    </button>
                    <button type="button" className={`inventory-summary-card ${inventoryTab === 'ebooks' ? 'active' : ''}`} onClick={() => { setInventoryTab('ebooks'); setInventoryQuery(''); }}>
                      <span className="inventory-summary-icon">💻</span>
                      <span><small>E-book files</small><strong>{ebooks.length}</strong><em>Digital collection</em></span>
                    </button>
                  </div>

                  <div className="inventory-toolbar">
                    <div className="inventory-tabs" role="tablist" aria-label="Inventory category">
                      <button type="button" role="tab" aria-selected={inventoryTab === 'books'} className={inventoryTab === 'books' ? 'active' : ''} onClick={() => { setInventoryTab('books'); setInventoryQuery(''); }}>Books</button>
                      <button type="button" role="tab" aria-selected={inventoryTab === 'research'} className={inventoryTab === 'research' ? 'active' : ''} onClick={() => { setInventoryTab('research'); setInventoryQuery(''); }}>Research</button>
                      <button type="button" role="tab" aria-selected={inventoryTab === 'ebooks'} className={inventoryTab === 'ebooks' ? 'active' : ''} onClick={() => { setInventoryTab('ebooks'); setInventoryQuery(''); }}>E-books</button>
                    </div>
                    <input className="inventory-search" value={inventoryQuery} onChange={(event) => setInventoryQuery(event.target.value)} placeholder={`Search ${inventoryTab} inventory...`} aria-label="Search inventory" />
                  </div>

                  {inventoryError && <div className="inventory-error" role="alert">{inventoryError}</div>}
                  {inventoryLoading ? (
                    <div className="inventory-empty"><IonSpinner name="crescent" /><span>Loading complete inventory...</span></div>
                  ) : (
                    <div className="inventory-table-wrap">
                      {inventoryTab === 'books' && (
                        <table className="inventory-table">
                          <thead><tr><th>ID</th><th>Book Title</th><th>Author</th><th>Category</th><th>Call Number</th><th>Total</th><th>Available</th><th>Borrowed</th></tr></thead>
                          <tbody>
                            {books.filter((item) => [item.title, item.author, item.category, item.call_number].some((value) => String(value || '').toLowerCase().includes(inventoryQuery.toLowerCase()))).map((item) => (
                              <tr key={item.id}><td>{item.id}</td><td className="inventory-title-cell">{item.title}</td><td>{item.author}</td><td>{item.category}</td><td>{item.call_number || '—'}</td><td>{item.total_copies}</td><td><span className="inventory-status available">{item.available_copies}</span></td><td>{Math.max(0, item.total_copies - item.available_copies)}</td></tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      {inventoryTab === 'research' && (
                        <table className="inventory-table">
                          <thead><tr><th>ID</th><th>Research Title</th><th>Authors</th><th>Year</th><th>Course</th><th>Subject</th><th>Type</th><th>Verification</th><th>PDF</th></tr></thead>
                          <tbody>
                            {researchItems.filter((item) => [item.title, item.authors, item.year, item.course, item.subject, item.research_type, item.verification_status].some((value) => String(value || '').toLowerCase().includes(inventoryQuery.toLowerCase()))).map((item) => (
                              <tr key={item.id}><td>{item.id}</td><td className="inventory-title-cell">{item.title}</td><td>{item.authors}</td><td>{item.year}</td><td>{item.course}</td><td>{item.subject}</td><td>{item.research_type || '—'}</td><td>{item.verification_status || 'Unverified'}</td><td><span className={`inventory-status ${item.has_pdf ? 'available' : 'missing'}`}>{item.has_pdf ? 'Available' : 'No PDF'}</span></td></tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      {inventoryTab === 'ebooks' && (
                        <table className="inventory-table">
                          <thead><tr><th>ID</th><th>E-book Title</th><th>Author</th><th>Category</th><th>Course</th><th>Year</th><th>Semester</th><th>Subject</th><th>File</th><th>Size</th></tr></thead>
                          <tbody>
                            {ebooks.filter((item) => [item.title, item.author, item.category, item.course, item.year, item.semester, item.subject, item.file_name].some((value) => String(value || '').toLowerCase().includes(inventoryQuery.toLowerCase()))).map((item) => (
                              <tr key={item.id}><td>{item.id}</td><td className="inventory-title-cell">{item.title}</td><td>{item.author}</td><td>{item.category}</td><td>{item.course || '—'}</td><td>{item.year || '—'}</td><td>{item.semester || '—'}</td><td>{item.subject || '—'}</td><td>{item.file_name}</td><td>{item.size || '—'}</td></tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      {((inventoryTab === 'books' && books.length === 0) || (inventoryTab === 'research' && researchItems.length === 0) || (inventoryTab === 'ebooks' && ebooks.length === 0)) && (
                        <div className="inventory-empty">No records found in this collection.</div>
                      )}
                    </div>
                  )}
                  <p className="inventory-footnote">Inventory data is read from the existing LibTrack collections. No records are changed by viewing or exporting this page.</p>
                </section>
              )}

              {/* BOOK CATALOG AND MANAGEMENT */}

              {(page === 'books' || (page === 'home' && !isAdmin)) && (

                <section className="catalog-section home-embedded-catalog">

                  <div className="section-heading">

                    <div>

                      <span className="eyebrow">

                        {isAdmin ? 'CATALOG MANAGEMENT' : 'FIND YOUR NEXT READ'}

                      </span>

                      {(isAdmin || page === 'books') && (
                        <h2>{isAdmin ? 'Book Inventory' : 'Book Catalog'}</h2>
                      )}

                      <p>

                        {isAdmin

                          ? 'Review, add, edit, and delete book records.'

                          : 'Search books and check availability.'}

                      </p>

                    </div>

                    {isAdmin && (

                      <IonButton

                        className="gold-button"

                        onClick={() => void saveBook()}

                        disabled={savingBook}

                      >

                        {savingBook ? (

                          <IonSpinner name="crescent" />

                        ) : (

                          '+ Add Book'

                        )}

                      </IonButton>

                    )}

                  </div>

                  {page === 'books' && isStudent && isPhilippineWeekend() && (
                    <div
                      role="status"
                      aria-live="polite"
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '12px',
                        margin: '14px 0 18px',
                        padding: '15px 17px',
                        border: '1px solid #f1d39a',
                        borderLeft: '5px solid #d99a2b',
                        borderRadius: '14px',
                        background: '#fff8e8',
                        color: '#684b18',
                        lineHeight: 1.55,
                      }}
                    >
                      <span aria-hidden="true" style={{ fontSize: '22px' }}>🗓️</span>
                      <div>
                        <strong style={{ display: 'block', marginBottom: '4px' }}>
                          No Book Borrowing on Saturdays and Sundays
                        </strong>
                        <span>
                          Book borrowing is not available on Saturdays and Sundays.
                          Please visit the library during regular operating days (Monday-Friday).
                        </span>
                      </div>
                    </div>
                  )}

                  <IonSearchbar

                    value={query}

                    onIonInput={(e) => setQuery(e.detail.value || '')}

                    placeholder="Search books or authors..."

                  />

                  {page === 'books' && (

                    <div className="category-filter">

                      <button

                        type="button"

                        className={`category-chip ${

                          selectedCategory === '' ? 'active' : ''

                        }`}

                        onClick={() => setSelectedCategory('')}

                      >

                        All Categories

                      </button>

                      {categories.map((category) => (

                        <button

                          type="button"

                          key={category}

                          className={`category-chip ${

                            selectedCategory === category ? 'active' : ''

                          }`}

                          onClick={() => setSelectedCategory(category)}

                        >

                          {displayCategoryName(category)}

                        </button>

                      ))}

                    </div>

                  )}

                  {booksLoading ? (

                    <div className="loading-row">

                      <IonSpinner name="crescent" />

                      <span>Loading catalog...</span>

                    </div>

                  ) : filteredBooks.length > 0 && isAdmin ? (

                    <div className="admin-table-wrap">

                      <table className="admin-book-table">

                        <thead>

                          <tr>

                            <th>Book title</th>

                            <th>Author</th>

                            <th>Category</th>

                            <th>Copies</th>

                            <th>Status</th>

                            <th>Actions</th>

                          </tr>

                        </thead>

                        <tbody>

                          {filteredBooks.map((book) => (

                            <tr key={book.id}>

                              <td>

                                <strong>{book.title}</strong>

                                <small>Book ID: {book.id}</small>

                              </td>

                              <td><AuthorDisplay book={book} /></td>

                              <td>{displayCategoryName(book.category || 'General', book.title)}</td>

                              <td>

                                {book.available_copies}/{book.total_copies}

                              </td>

                              <td>

                                <IonBadge

                                  color={book.available ? 'success' : 'medium'}

                                >

                                  {book.available ? 'Available' : 'Unavailable'}

                                </IonBadge>

                              </td>

                              <td>

                                <div className="inventory-actions">

                                  <IonButton

                                    size="small"

                                    fill="outline"

                                    onClick={() => void saveBook(book)}

                                    disabled={savingBook}

                                  >

                                    Edit

                                  </IonButton>

                                  <IonButton

                                    size="small"

                                    color="danger"

                                    fill="outline"

                                    onClick={() => void deleteBook(book)}

                                  >

                                    Delete

                                  </IonButton>

                                </div>

                              </td>

                            </tr>

                          ))}

                        </tbody>

                      </table>

                    </div>

                  ) : filteredBooks.length > 0 ? (

                    <div className="book-grid">

                      {filteredBooks.map((book, index) => (

                        <article key={book.id} className="book-tile">

                          <BookCover book={book} index={index} />

                          <div className="book-info">

                            <button

                              type="button"

                              className="book-category category-link"

                              onClick={() => {

                                setSelectedCategory(canonicalBookCategory(book.category || 'General', book.title));

                                setPage('categories');

                              }}

                            >

                              {displayCategoryName(book.category || 'General', book.title)}

                            </button>

                            <h3>{book.title}</h3>

                            <p><AuthorDisplay book={book} prefix="by " /></p>

                            <div className="book-meta">

                              <IonBadge

                                color={book.available ? 'success' : 'medium'}

                              >

                                {book.available

                                  ? `${book.available_copies} available`

                                  : 'Unavailable'}

                              </IonBadge>

                              <span>

                                {book.available_copies}/{book.total_copies} copies

                              </span>

                            </div>

                            <button
                              type="button"
                              onClick={() => setSelectedBook(book)}
                              style={{ marginTop: '14px', border: '1px solid #b99a62', borderRadius: '10px', padding: '9px 12px', background: 'transparent', color: 'inherit', cursor: 'pointer', fontWeight: 600 }}
                            >
                              View About This Book →
                            </button>

                          </div>

                        </article>

                      ))}

                    </div>

                  ) : (

                    <div className="empty-state">

                      <h3>No books found</h3>

                      <p>Try a different search or category.</p>

                    </div>

                  )}



                </section>

              )}

              {/* ALL REGISTERED ACCOUNTS */}

              {page === 'accounts' && isAdmin && (
                <>
                <section className="logged-in-section">

                  <div className="logged-in-heading">

                    <div>

                      <span className="eyebrow">USER MANAGEMENT</span>

                      <h2>All Registered Accounts</h2>

                    </div>

                    <IonBadge color="primary">

                      {accounts.length} Total Accounts

                    </IonBadge>

                  </div>

                  <IonSearchbar

                    value={accountQuery}

                    onIonInput={(e) =>

                      setAccountQuery(e.detail.value || '')

                    }

                    placeholder="Search by name, School ID, course, year, or section..."

                  />

                  {accountsError && (

                    <IonText color="danger">

                      <p role="alert">

                        Could not load accounts: {accountsError}

                      </p>

                    </IonText>

                  )}

                  <div role="tablist" aria-label="Filter accounts by course" style={{ display: 'flex', alignItems: 'center', gap: 8, overflowX: 'auto', padding: '8px 4px 14px', margin: '4px 0 8px', borderBottom: '1px solid #e2e8f0' }}>
                    {['BSIT', 'BSED', 'BSBA', 'FACULTY ACCOUNTS', 'ADMIN ACCOUNTS']
                      .map((name) => {
                        const count = accountCourseGroups.find(([groupName]) => groupName === name)?.[1].length || 0;
                        const active = visibleAccountGroup === name;
                        return (
                          <button
                            key={name}
                            type="button"
                            role="tab"
                            aria-selected={active}
                            onClick={() => { setSelectedAccountGroup(name); setExpandedStudentId(null); }}
                            style={{ flex: '0 0 auto', border: active ? '1px solid #173b60' : '1px solid #dbe3eb', borderRadius: 10, padding: '10px 18px', background: active ? '#173b60' : '#edf2f7', color: active ? '#ffffff' : '#526174', fontWeight: 800, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}
                          >
                            {name === 'ADMIN ACCOUNTS' ? 'ADMIN' : name === 'FACULTY ACCOUNTS' ? 'FACULTY' : name}
                            <span style={{ marginLeft: 7, opacity: active ? 0.82 : 0.72, fontWeight: 650 }}>({count})</span>
                          </button>
                        );
                      })}
                  </div>

                  {accountsLoading && accounts.length === 0 ? (

                    <div className="sessions-loading">

                      <IonSpinner name="crescent" />

                      <span>Loading all accounts...</span>

                    </div>

                  ) : (

                    <div className="sessions-table-wrap">

                      <table className="sessions-table">

                        <thead>

                          <tr>

                            <th>Account</th>

                            {visibleAccountGroup !== 'FACULTY ACCOUNTS' && visibleAccountGroup !== 'ADMIN ACCOUNTS' && (
                              <>
                                <th>School ID</th>
                                <th>Course</th>
                                <th>Year</th>
                                <th>Section</th>
                              </>
                            )}

                            <th>Email</th>

                            <th>Role</th>

                            <th>Status</th>

                            <th>Action</th>

                          </tr>

                        </thead>

                        <tbody>

                          {visibleAccountGroups.map(([courseName, courseAccounts]) => (
                            <React.Fragment key={courseName}>
                              <tr>
                                <td colSpan={visibleAccountGroup === 'FACULTY ACCOUNTS' || visibleAccountGroup === 'ADMIN ACCOUNTS' ? 5 : 9} style={{ background: '#edf3f8', color: '#173b60', fontWeight: 800, letterSpacing: '.04em' }}>
                                  {courseName}
                                  {courseName !== 'ADMIN ACCOUNTS' && (
                                    <span style={{ fontWeight: 600, color: '#64748b' }}>
                                       ({courseAccounts.length} {courseName === 'FACULTY ACCOUNTS' ? (courseAccounts.length === 1 ? 'faculty member' : 'faculty members') : (courseAccounts.length === 1 ? 'student' : 'students')})
                                    </span>
                                  )}
                                </td>
                              </tr>
                              {courseAccounts.map((account) => {
                                const online = isAccountOnline(account);
                                const studentBorrowings = borrowings.filter((record) => record.user_id === account.id);
                                const expanded = expandedStudentId === account.id;
                                return (
                                  <React.Fragment key={account.id}>
                                    <tr>
                                      <td>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 210 }}>
                                          <button type="button" aria-label={`Preview ${account.full_name}'s profile photo`} disabled={!account.profile_photo_url} onClick={() => account.profile_photo_url && setProfilePhotoPreview({ url: account.profile_photo_url, name: account.full_name || 'Profile photo' })} style={{ width: 42, height: 42, flex: '0 0 42px', borderRadius: '50%', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, background: '#f4c64e', color: '#173b60', border: '2px solid #e2e8f0', fontWeight: 800, fontSize: 16, cursor: account.profile_photo_url ? 'zoom-in' : 'default' }}>
                                            {account.profile_photo_url ? (
                                              <img src={account.profile_photo_url} alt={`${account.full_name} profile`} loading="lazy" referrerPolicy="no-referrer" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={(event) => { event.currentTarget.style.display = 'none'; }} />
                                            ) : (account.full_name || account.email || 'U').trim().charAt(0).toUpperCase()}
                                          </button>
                                          {String(account.role || '').toLowerCase() === 'admin' ? (
                                            <div style={{ color: '#173b60', textAlign: 'left' }}>
                                              <strong>{account.full_name}</strong>
                                              <small style={{ display: 'block', color: '#64748b' }}>{account.username ? `@${account.username}` : 'Administrator'}</small>
                                            </div>
                                          ) : (
                                            <button type="button" onClick={() => setExpandedStudentId(expanded ? null : account.id)} style={{ border: 0, background: 'transparent', color: '#173b60', padding: 0, textAlign: 'left', cursor: 'pointer', font: 'inherit' }}>
                                              <strong>{account.full_name}</strong>
                                              <small style={{ display: 'block', color: '#64748b' }}>{account.username ? `@${account.username}` : account.role?.toLowerCase() === 'faculty' ? 'Faculty account' : 'Student account'} · {expanded ? 'Hide records ▲' : 'View records ▼'}</small>
                                            </button>
                                          )}
                                        </div>
                                      </td>
                                      {visibleAccountGroup !== 'FACULTY ACCOUNTS' && visibleAccountGroup !== 'ADMIN ACCOUNTS' && (
                                        <>
                                          <td>{account.student_id?.trim() || '—'}</td>
                                          <td>{account.course?.trim() || '—'}</td>
                                          <td>{account.year?.trim() || '—'}</td>
                                          <td>{account.section?.trim() || '—'}</td>
                                        </>
                                      )}
                                      <td>{account.email}</td>
                                      <td><IonBadge color={account.role.toLowerCase() === 'admin' ? 'warning' : 'medium'}>{account.role}</IonBadge></td>
                                      <td>{online ? <span className="session-online"><span className="session-online-dot" />Online</span> : <span className="session-offline"><span className="session-offline-dot" />Offline</span>}</td>
                                      <td>
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                                          {String(account.role || '').toLowerCase() !== 'admin' && (
                                            <IonButton size="small" color="primary" fill="outline" onClick={() => void editAccountDetails(account)}>Edit</IonButton>
                                          )}
                                          <IonButton size="small" color="danger" fill="outline" disabled={deletingAccountId === account.id || (!!user && account.id === user.id)} onClick={() => deleteAccount(account)}>
                                            {deletingAccountId === account.id ? 'Deleting...' : 'Delete'}
                                          </IonButton>
                                        </div>
                                      </td>
                                    </tr>
                                    {expanded && String(account.role || '').toLowerCase() !== 'admin' && (
                                      <tr>
                                        <td colSpan={visibleAccountGroup === 'FACULTY ACCOUNTS' || visibleAccountGroup === 'ADMIN ACCOUNTS' ? 5 : 9} style={{ background: '#f8fafc', padding: 16 }}>
                                          <div style={{ display: 'grid', gap: 10 }}>
                                            <strong style={{ color: '#173b60' }}>Borrowing History — {account.full_name}</strong>
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                              <IonBadge color="primary">{studentBorrowings.length} Total Records</IonBadge>
                                              <IonBadge color="warning">{studentBorrowings.filter((r) => r.status === 'borrowed').length} Currently Borrowed</IonBadge>
                                              <IonBadge color="success">{studentBorrowings.filter((r) => r.status === 'returned').length} Returned</IonBadge>
                                            </div>
                                            {borrowingsError && <IonText color="danger">{borrowingsError}</IonText>}
                                            {studentBorrowings.length === 0 ? (
                                              <span style={{ color: '#64748b' }}>This account has no borrowing records yet.</span>
                                            ) : (
                                              <div style={{ overflowX: 'auto' }}>
                                                <table className="sessions-table">
                                                  <thead><tr><th>Book Title</th><th>Borrowed Date</th><th>Due Date</th><th>Returned Date</th><th>Status</th></tr></thead>
                                                  <tbody>
                                                    {studentBorrowings.map((record) => {
                                                      const book = books.find((item) => item.id === record.book_id);
                                                      const overdue = record.status === 'borrowed' && record.due_date < new Date().toISOString().slice(0, 10);
                                                      return (
                                                        <tr key={record.id}>
                                                          <td>{book?.title || `Book #${record.book_id}`}</td>
                                                          <td>{record.borrowed_at ? new Date(record.borrowed_at).toLocaleDateString('en-PH') : '—'}</td>
                                                          <td>{record.due_date}</td>
                                                          <td>{record.returned_at ? new Date(record.returned_at).toLocaleDateString('en-PH') : '—'}</td>
                                                          <td><IonBadge color={record.status === 'returned' ? 'success' : overdue ? 'danger' : record.status === 'pending' ? 'warning' : 'primary'}>{overdue ? 'Overdue' : record.status}</IonBadge></td>
                                                        </tr>
                                                      );
                                                    })}
                                                  </tbody>
                                                </table>
                                              </div>
                                            )}
                                          </div>
                                        </td>
                                      </tr>
                                    )}
                                  </React.Fragment>
                                );
                              })}
                            </React.Fragment>
                          ))}
                          {filteredAccounts.length === 0 && (

                            <tr>

                              <td colSpan={9} className="sessions-empty">

                                {accounts.length === 0

                                  ? 'No registered accounts yet.'

                                  : 'No accounts match your search.'}

                              </td>

                            </tr>

                          )}

                        </tbody>

                      </table>

                    </div>

                  )}

                </section>

                {editingAccount && (
                  <div role="presentation" onClick={(event) => { if (event.target === event.currentTarget && !accountEditSaving) setEditingAccount(null); }} style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(15, 30, 48, .58)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
                    <section role="dialog" aria-modal="true" aria-labelledby="edit-account-title" style={{ width: 'min(720px, 100%)', maxHeight: '92vh', overflowY: 'auto', background: '#fff', borderRadius: 18, boxShadow: '0 18px 60px rgba(0,0,0,.25)' }}>
                      <header style={{ padding: '20px 24px', background: 'linear-gradient(110deg, #173b60, #315a61)', borderBottom: '5px solid #e9c85b', color: '#fff', borderRadius: '18px 18px 0 0' }}>
                        <h2 id="edit-account-title" style={{ margin: 0, fontSize: 24 }}>Edit Account</h2>
                        <p style={{ margin: '6px 0 0', color: 'rgba(255,255,255,.85)', fontSize: 14 }}>Update the account details below.</p>
                      </header>
                      <div style={{ padding: 24, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}>
                        {(String(editingAccount.role || '').toLowerCase() === 'faculty'
                          ? ([
                              ['Full Name', 'full_name', 'text'], ['Email Address', 'email', 'email'], ['Username', 'username', 'text'],
                            ] as const)
                          : ([
                              ['Full Name', 'full_name', 'text'], ['Email Address', 'email', 'email'], ['Username', 'username', 'text'], ['School ID', 'student_id', 'text'],
                              ['Course', 'course', 'text'], ['Year', 'year', 'text'], ['Section', 'section', 'text'],
                            ] as const)
                        ).map(([label, key, type]) => (
                          <label key={key} style={{ display: 'grid', gap: 7, color: '#526174', fontSize: 13, fontWeight: 700, minWidth: 0 }}>
                            {label}
                            <input type={type} value={accountEditDraft[key]} onChange={(event) => setAccountEditDraft((draft) => ({ ...draft, [key]: event.target.value }))} placeholder={label} style={{ width: '100%', minWidth: 0, boxSizing: 'border-box', minHeight: 52, padding: '0 15px', border: '1px solid #d4dfeb', borderRadius: 13, background: '#f7f9fb', color: '#203047', font: 'inherit', fontWeight: 400 }} />
                          </label>
                        ))}
                      </div>
                      <footer style={{ position: 'sticky', bottom: 0, display: 'flex', justifyContent: 'flex-end', gap: 12, padding: '16px 24px 22px', background: '#fff', borderTop: '1px solid #e7edf3', borderRadius: '0 0 18px 18px' }}>
                        <IonButton fill="outline" color="medium" onClick={() => setEditingAccount(null)} disabled={accountEditSaving}>Cancel</IonButton>
                        <IonButton onClick={() => void saveAccountEdits()} disabled={accountEditSaving}>{accountEditSaving ? <IonSpinner name="crescent" /> : 'Save Changes'}</IonButton>
                      </footer>
                    </section>
                  </div>
                )}
                </>
              )}

              {/* ACTIVE LOGIN SESSIONS */}

              {page === 'sessions' && isAdmin && (

                <section className="logged-in-section">

                  <div className="logged-in-heading">

                    <div>

                      <span className="eyebrow">ACCOUNT MONITORING</span>

                      <h2>Logged-in Accounts</h2>

                      <p>

                        Accounts with recent activity in the last 90 seconds.

                      </p>

                    </div>

                    <IonBadge color="success">

                      {loginSessions.length} Online

                    </IonBadge>

                  </div>

                  {sessionsError && (

                    <IonText color="danger">

                      <p role="alert">

                        Could not retrieve sessions: {sessionsError}

                      </p>

                    </IonText>

                  )}

                  {sessionsLoading && loginSessions.length === 0 ? (

                    <div className="sessions-loading">

                      <IonSpinner name="crescent" />

                      <span>Loading logged-in accounts...</span>

                    </div>

                  ) : (

                    <div className="sessions-table-wrap">

                      <table className="sessions-table">

                        <thead>

                          <tr>

                            <th>Account</th>

                            <th>School ID</th>

                            <th>Course</th>

                            <th>Email</th>

                            <th>Role</th>

                            <th>Status</th>

                            <th>Last Activity</th>

                          </tr>

                        </thead>

                        <tbody>

                          {loginSessions.length === 0 ? (

                            <tr>

                              <td colSpan={7} className="sessions-empty">

                                {sessionsError

                                  ? 'Could not load the account list.'

                                  : 'There are no active sessions right now.'}

                              </td>

                            </tr>

                          ) : (

                            loginSessions.map((session) => {
                              const account = accounts.find((item) => item.id === session.user_id);
                              return (
                                <tr key={`${session.user_id}-${session.login_at}`}>
                                  <td><strong>{session.full_name}</strong></td>
                                  <td>{account?.student_id?.trim() || '—'}</td>
                                  <td>{account?.course?.trim() || '—'}</td>
                                  <td>{session.email}</td>
                                  <td>
                                    <IonBadge color={session.role.toLowerCase() === 'admin' ? 'warning' : 'medium'}>
                                      {session.role}
                                    </IonBadge>
                                  </td>
                                  <td>
                                    <span className="session-online">
                                      <span className="session-online-dot" />
                                      {session.status}
                                    </span>
                                  </td>
                                  <td>{formatPhilippineTime(session.last_seen)}</td>
                                </tr>
                              );
                            })

                          )}

                        </tbody>

                      </table>

                    </div>

                  )}

                </section>

              )}

              {borrowRequestConfirmation && (
                <div
                  role="presentation"
                  onClick={() => setBorrowRequestConfirmation(null)}
                  style={{ position: 'fixed', inset: 0, zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', background: 'rgba(15, 23, 42, 0.62)', backdropFilter: 'blur(4px)' }}
                >
                  <section
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="borrow-request-title"
                    onClick={(event) => event.stopPropagation()}
                    style={{ width: '100%', maxWidth: '430px', background: 'var(--ion-card-background, #ffffff)', color: 'var(--ion-text-color, #172033)', borderRadius: '20px', padding: '28px', boxShadow: '0 24px 70px rgba(0,0,0,0.28)' }}
                  >
                    <h2 id="borrow-request-title" style={{ textAlign: 'center', margin: '0 0 12px', fontSize: '22px' }}>Confirm Borrowing</h2>
                    <p style={{ textAlign: 'center', margin: '0 0 12px', lineHeight: 1.55 }}>
                      Do you want to borrow <strong>“{borrowRequestConfirmation.title}”</strong> by {borrowRequestConfirmation.author}?
                    </p>
                    <p style={{ textAlign: 'center', margin: '0 0 22px', lineHeight: 1.55, opacity: 0.78 }}>
                      If you confirm, your request will be sent to the admin. The admin will set your return due date.
                    </p>
                    <div style={{ display: 'flex', gap: '10px' }}>
                      <IonButton expand="block" fill="outline" color="medium" style={{ flex: 1, margin: 0 }} onClick={() => setBorrowRequestConfirmation(null)} disabled={loading}>
                        Cancel
                      </IonButton>
                      <IonButton expand="block" style={{ flex: 1, margin: 0, '--background': '#e8c15a', '--background-hover': '#d8ad43', '--color': '#17283f', '--box-shadow': '0 5px 13px rgba(191,148,49,.22)' } as React.CSSProperties} disabled={loading} onClick={() => {
                        const book = borrowRequestConfirmation;
                        if (book) void submitBorrowRequest(book);
                      }}>
                        {loading ? 'Processing…' : 'Borrow'}
                      </IonButton>
                    </div>
                  </section>
                </div>
              )}

              {pickupConfirmation && (
                <div
                  role="presentation"
                  onClick={() => setPickupConfirmation(null)}
                  style={{
                    position: 'fixed', inset: 0, zIndex: 10000,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: '20px', background: 'rgba(15, 32, 52, 0.68)',
                    backdropFilter: 'blur(6px)',
                  }}
                >
                  <section
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="pickup-modal-title"
                    onClick={(event) => event.stopPropagation()}
                    style={{
                      width: '100%', maxWidth: '430px', background: 'var(--ion-card-background, #ffffff)',
                      color: '#203047', borderRadius: '20px',
                      padding: '28px', border: '1px solid #e3e9ef', borderTop: '5px solid #e7c15b', boxShadow: '0 24px 70px rgba(18,39,63,0.28)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                      <div style={{
                        width: '64px', height: '64px', borderRadius: '50%',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'rgba(232, 193, 90, 0.22)', color: '#17283f', fontSize: '30px', border: '1px solid rgba(195,155,62,.25)',
                      }} aria-hidden="true">✓</div>
                    </div>
                    <h2 id="pickup-modal-title" style={{ textAlign: 'center', margin: '0 0 8px', fontSize: '22px' }}>
                      Confirm Book Pickup
                    </h2>
                    <p style={{ textAlign: 'center', margin: '0 0 20px', lineHeight: 1.55, opacity: 0.78 }}>
                      Please confirm that the student has arrived at the library and has received the book.
                    </p>
                    <label htmlFor="admin-approval-due-date" style={{ display: 'block', fontWeight: 600, marginBottom: '8px' }}>
                      Return Due Date
                    </label>
                    <input
                      id="admin-approval-due-date"
                      type="date"
                      min={(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })()}
                      max={(() => { const d = new Date(); d.setDate(d.getDate() + 7); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })()}
                      value={approvalDueDate}
                      onChange={(event) => setApprovalDueDate(event.target.value)}
                      style={{ width: '100%', boxSizing: 'border-box', padding: '12px', marginBottom: '18px', border: '1px solid var(--ion-color-medium, #92949c)', borderRadius: '10px', background: 'var(--ion-background-color, #fff)', color: 'var(--ion-text-color, #172033)', font: 'inherit' }}
                    />
                    <div style={{
                      padding: '14px 16px', borderRadius: '12px', marginBottom: '22px',
                      background: 'var(--ion-color-light, #f4f6f9)', lineHeight: 1.5,
                    }}>
                      <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', opacity: 0.65, marginBottom: '5px' }}>
                        IMPORTANT
                      </div>
                      Confirming will mark this request as borrowed and update the available book copies.
                    </div>
                    <div style={{ display: 'flex', gap: '10px' }}>
                      <IonButton
                        expand="block"
                        fill="outline"
                        color="medium"
                        style={{ flex: 1, margin: 0 }}
                        onClick={() => setPickupConfirmation(null)}
                        disabled={loading}
                      >
                        Cancel
                      </IonButton>
                      <IonButton
                        expand="block"
                        style={{ flex: 1, margin: 0, '--background': '#e8c15a', '--background-hover': '#d8ad43', '--color': '#17283f', '--box-shadow': '0 5px 13px rgba(191,148,49,.22)' } as React.CSSProperties}
                        onClick={() => {
                          const record = pickupConfirmation;
                          if (record) void approveBorrowing(record, approvalDueDate);
                          setPickupConfirmation(null);
                        }}
                        disabled={loading}
                      >
                        {loading ? 'Processing…' : 'Confirm Pickup'}
                      </IonButton>
                    </div>
                  </section>
                </div>
              )}

              {returnConfirmation && (
                <div role="presentation" onClick={() => setReturnConfirmation(null)} style={{
                  position: 'fixed', inset: 0, zIndex: 10001, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', padding: '20px', background: 'rgba(15, 32, 52, 0.68)',
                  backdropFilter: 'blur(6px)',
                }}>
                  <section role="dialog" aria-modal="true" aria-labelledby="return-modal-title"
                    onClick={(event) => event.stopPropagation()} style={{
                      width: '100%', maxWidth: '430px', background: 'var(--ion-card-background, #ffffff)',
                      color: '#203047', borderRadius: '20px', padding: '28px', border: '1px solid #e3e9ef', borderTop: '5px solid #e7c15b',
                      boxShadow: '0 24px 70px rgba(18,39,63,0.28)',
                    }}>
                    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                      <div style={{ width: '64px', height: '64px', borderRadius: '50%', display: 'flex',
                        alignItems: 'center', justifyContent: 'center', background: 'rgba(232, 193, 90, 0.22)',
                        color: '#17283f', fontSize: '30px', border: '1px solid rgba(195,155,62,.25)' }} aria-hidden="true">✓</div>
                    </div>
                    <h2 id="return-modal-title" style={{ textAlign: 'center', margin: '0 0 8px', fontSize: '22px' }}>Confirm Book Return</h2>
                    <p style={{ textAlign: 'center', margin: '0 0 20px', lineHeight: 1.55, opacity: 0.78 }}>
                      Has the student physically returned this book to the library?
                    </p>
                    <div style={{ padding: '14px 16px', borderRadius: '12px', marginBottom: '22px',
                      background: 'var(--ion-color-light, #f4f6f9)', lineHeight: 1.5 }}>
                      <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', opacity: 0.65, marginBottom: '5px' }}>IMPORTANT</div>
                      Confirming will mark this loan as returned and increase the available book copies.
                    </div>
                    <div style={{ display: 'flex', gap: '10px' }}>
                      <IonButton expand="block" fill="outline" color="medium" style={{ flex: 1, margin: 0 }}
                        onClick={() => setReturnConfirmation(null)} disabled={loading}>Cancel</IonButton>
                      <IonButton expand="block" style={{ flex: 1, margin: 0, '--background': '#e8c15a', '--background-hover': '#d8ad43', '--color': '#17283f', '--box-shadow': '0 5px 13px rgba(191,148,49,.22)' } as React.CSSProperties} disabled={loading}
                        onClick={() => { const record = returnConfirmation; setReturnConfirmation(null); if (record) void returnBorrowing(record); }}>
                        {loading ? 'Processing…' : 'Confirm Return'}
                      </IonButton>
                    </div>
                  </section>
                </div>
              )}

                  {selectedBook && (
                    <div
                      role="dialog"
                      aria-modal="true"
                      aria-labelledby="book-about-title"
                      style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(15, 23, 42, 0.68)', display: 'grid', placeItems: 'center', padding: '20px', overflowY: 'auto' }}
                      onClick={(event) => {
                        if (event.target === event.currentTarget) setSelectedBook(null);
                      }}
                    >
                      <section style={{ position: 'relative', width: 'min(100%, 620px)', maxHeight: '90vh', overflowY: 'auto', background: 'var(--ion-background-color, #fff)', color: 'var(--ion-text-color, #222)', borderRadius: '20px', padding: '28px', boxShadow: '0 24px 80px rgba(0,0,0,.28)' }}>
                        <button
                          type="button"
                          onClick={() => setSelectedBook(null)}
                          aria-label="Close book details"
                          style={{ position: 'absolute', right: '16px', top: '10px', border: 0, background: 'transparent', fontSize: '30px', cursor: 'pointer', color: 'inherit' }}
                        >
                          ×
                        </button>
                        <div
                          className="book-cover-detail-frame"
                          style={{ boxShadow: '0 10px 26px rgba(15, 35, 55, .18)' }}
                        >
                          <BookCover
                            book={selectedBook}
                            index={selectedBook.id}
                            className="book-cover book-cover-detail"
                          />
                        </div>
                        <span className="eyebrow">ABOUT THIS BOOK</span>
                        <h2 id="book-about-title">{selectedBook.title}</h2>
                        <p style={{ color: '#8a6b35', marginTop: '4px' }}><AuthorDisplay book={selectedBook} prefix="by " /></p>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', margin: '18px 0' }}>
                          <span style={{ background: '#f3ead8', color: '#5f4722', borderRadius: '999px', padding: '6px 12px' }}>{displayCategoryName(selectedBook.category || 'General')}</span>
                          {selectedBook.call_number && <span>Call No.: {selectedBook.call_number}</span>}
                        </div>
                        <h3>About This Book</h3>
                        <BookAbout book={selectedBook} />
                        <p style={{ marginTop: '20px', fontWeight: 600 }}>
                          {selectedBook.available_copies > 0
                            ? `${selectedBook.available_copies} of ${selectedBook.total_copies} copies are currently available.`
                            : 'This book is currently unavailable.'}
                        </p>
                        <IonButton
                          expand="block"
                          onClick={() => {
                            setSelectedBook(null);
                            if (!isAdmin) navigate('categories');
                          }}
                        >
                          {isAdmin ? 'Back to Catalog' : 'Back to Categories'}
                        </IonButton>
                      </section>
                    </div>
                  )}

              {page === 'borrowings' && !isAdmin && (
                <section className="quick-section admin-borrowing-section">
                  <div className="section-heading">
                    <div>
                      <span className="eyebrow">YOUR LIBRARY RECORDS</span>
                      <h2>My Borrowing History</h2>
                      <p>Check your return due dates, current borrowing status, and previous returns.</p>
                    </div>
                    <IonBadge color="primary">{borrowings.length} records</IonBadge>
                  </div>

                  {borrowingsError && <p className="form-message" role="alert">Could not load your borrowing history: {borrowingsError}</p>}
                  {borrowingsLoading ? (
                    <div className="loading-row"><IonSpinner name="crescent" /><span>Loading your borrowing history...</span></div>
                  ) : borrowings.length === 0 ? (
                    <p className="empty-state">You do not have any borrowing records yet. Your reservations and loans will appear here.</p>
                  ) : (
                    <div className="admin-table-wrap">
                      <table className="admin-book-table">
                        <thead><tr><th>Book</th><th>Request / Borrowed Date</th><th>Return Due Date</th><th>Returned Date</th><th>Status</th></tr></thead>
                        <tbody>
                          {borrowings.map((record) => {
                            const borrowedBook = books.find((book) => book.id === record.book_id);
                            const isOverdue = record.status === 'borrowed' && (record.overdue || record.due_date < new Date().toISOString().slice(0, 10));
                            const statusLabel = record.status === 'pending' ? 'Pending Approval' : record.status === 'returned' ? 'Returned' : isOverdue ? 'Overdue' : record.status === 'borrowed' ? 'Borrowed' : record.status;
                            const statusColor = record.status === 'returned' ? 'success' : record.status === 'pending' ? 'tertiary' : isOverdue ? 'danger' : 'warning';
                            return (
                              <tr key={record.id}>
                                <td data-label="Book"><strong>{borrowedBook?.title || `Book #${record.book_id}`}</strong><small>Record #{record.id}</small></td>
                                <td data-label="Request / Borrowed Date">{record.borrowed_at ? new Date(record.borrowed_at).toLocaleDateString() : '—'}</td>
                                <td data-label="Return Due Date"><strong>{record.due_date || '—'}</strong>{isOverdue && <small style={{ color: 'var(--ion-color-danger)' }}>Please return this book as soon as possible.</small>}</td>
                                <td data-label="Returned Date">{record.returned_at ? new Date(record.returned_at).toLocaleDateString() : '—'}</td>
                                <td data-label="Status"><IonBadge color={statusColor}>{statusLabel}</IonBadge></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              )}



              {page === 'lostBooks' && isAdmin && (
                <section className="quick-section admin-borrowing-section" style={{ marginTop: 22 }}>
                  <div className="section-heading">
                    <div>
                      <span className="eyebrow">NEUST LIBRARY POLICY · SECTION 8.6</span>
                      <h2>Lost &amp; Damaged Books</h2>
                      <p>Track reported books, payment or replacement deadlines, and unsettled borrower accounts.</p>
                    </div>
                    <IonBadge color="warning">{lostBookCases.filter((item) => item.resolution_status === 'unsettled').length} unsettled</IonBadge>
                  </div>
                  {lostCasesLoading ? <div className="loading-row"><IonSpinner name="crescent" /><span>Loading cases...</span></div> :
                    lostBookCases.length === 0 ? <p className="empty-state">No lost or damaged book cases have been reported.</p> :
                    <div className="admin-table-wrap">
                      <table className="admin-book-table">
                        <thead><tr><th>Borrower / Book</th><th>Case</th><th>Amount Due</th><th>Deadline</th><th>Status / Action</th></tr></thead>
                        <tbody>
                          {lostBookCases.map((item) => {
                            const borrower = accounts.find((account) => account.id === item.user_id);
                            const book = books.find((entry) => entry.id === item.book_id);
                            return <tr key={item.id}>
                              <td><strong>{borrower?.full_name || `User #${item.user_id}`}</strong><small>{book?.title || `Book #${item.book_id}`}</small></td>
                              <td>{item.case_type.toUpperCase()}<small>Reported: {item.report_date}</small></td>
                              <td><strong>₱{item.amount_due.toFixed(2)}</strong><small>Book ₱{item.market_value.toFixed(2)} + ₱{item.processing_fee.toFixed(2)} fee</small></td>
                              <td>{item.deadline}</td>
                              <td>
                                <IonBadge color={item.resolution_status === 'unsettled' ? 'danger' : 'success'}>{item.resolution_status.toUpperCase()}</IonBadge>
                                {item.resolution_status === 'unsettled' ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 7 }}>
                                  <IonButton size="small" color="success" disabled={loading} onClick={() => openResolveLostBookCase(item, 'paid')}>Mark Paid</IonButton>
                                  <IonButton size="small" color="tertiary" disabled={loading} onClick={() => openResolveLostBookCase(item, 'replaced')}>Mark Replaced</IonButton>
                                </div> : <div style={{ marginTop: 7 }}>
                                  <IonButton size="small" fill="outline" color="primary" onClick={() => setReceiptPreviewCase(item)}>View Receipt</IonButton>
                                </div>}
                              </td>
                            </tr>;
                          })}
                        </tbody>
                      </table>
                    </div>}
                </section>
              )}

              {page === 'borrowings' && isAdmin && (

                <>

                    <section className="quick-section admin-borrowing-section">

                      <div className="section-heading">

                        <div>

                          <span className="eyebrow">LIVE TRANSACTIONS</span>

                          <h2>Borrowing Activity</h2>

                          <p>Confirm pickup only after the student receives the book. Record the return when the book is physically returned to the library. Updates refresh every 10 seconds.</p>

                        </div>

                        <IonBadge color="primary">{borrowings.length} records</IonBadge>

                      </div>

                      {borrowingsError && <p className="form-message" role="alert">Could not load borrowing records: {borrowingsError}</p>}

                      {borrowingsLoading ? (

                        <div className="loading-row"><IonSpinner name="crescent" /><span>Loading borrowing records...</span></div>

                      ) : borrowings.length === 0 ? (

                        <p className="empty-state">No borrowing records yet. Student reservations will appear here.</p>

                      ) : (

                        <div className="admin-table-wrap">

                          <table className="admin-book-table">

                            <thead><tr><th>Student</th><th>Book</th><th>Requested / Borrowed at</th><th>Due date</th><th>Status / Action</th></tr></thead>

                            <tbody>

                              {borrowings.map((record) => {

                                const borrower = accounts.find((account) => account.id === record.user_id);

                                const borrowedBook = books.find((book) => book.id === record.book_id);

                                return (

                                  <tr key={record.id}>

                                    <td><strong>{borrower?.full_name || `Student #${record.user_id}`}</strong><small>User ID: {record.user_id}</small></td>

                                    <td><strong>{borrowedBook?.title || `Book #${record.book_id}`}</strong><small>Book ID: {record.book_id}</small></td>

                                    <td>{record.borrowed_at ? new Date(record.borrowed_at).toLocaleString() : '—'}</td>

                                    <td>{record.due_date}</td>

                                    <td>
                                      <div className="borrowing-status-actions">
                                        <IonBadge className="borrowing-status-badge" color={record.status === 'returned' ? 'success' : record.status === 'pending' ? 'tertiary' : record.status === 'lost' ? 'danger' : record.overdue ? 'danger' : 'warning'}>
                                          {record.overdue ? 'OVERDUE' : record.status === 'pending' ? 'Pending approval' : record.status}
                                        </IonBadge>
                                        {record.status === 'pending' && (
                                          <IonButton size="small" className="gold-button borrowing-action-button" disabled={loading} onClick={() => setPickupConfirmation(record)}>
                                            {loading ? 'Processing…' : 'Confirm Pickup'}
                                          </IonButton>
                                        )}
                                        {record.status === 'borrowed' && (
                                          <IonButton size="small" color="success" className="borrowing-action-button" disabled={loading} onClick={() => setReturnConfirmation(record)}>
                                            Return Book
                                          </IonButton>
                                        )}
                                        {record.status === 'borrowed' && (
                                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                            <IonButton size="small" color="danger" fill="outline" disabled={loading} onClick={() => void reportLostBook(record, 'lost')}>Report Lost</IonButton>
                                            <IonButton size="small" color="warning" fill="outline" disabled={loading} onClick={() => void reportLostBook(record, 'damaged')}>Report Damaged</IonButton>
                                          </div>
                                        )}
                                      </div>
                                    </td>

                                  </tr>

                                );

                              })}

                            </tbody>

                          </table>

                        </div>

                      )}

                    </section>

                </>

              )}



              {/* BOOK CATEGORIES */}

              {page === 'categories' && (

                <section className="catalog-section category-page">

                  <div className="page-intro">

                    <span className="eyebrow">EXPLORE THE LIBRARY</span>

                    <h2><strong>Book Categories</strong></h2>

                    <p>Select a category to see books that belong to it.</p>

                  </div>

                  <div className="category-search">

                    <IonSearchbar

                      value={query}

                      onIonInput={(e) => setQuery(e.detail.value || '')}

                      placeholder="Search by title or author..."

                    />

                  </div>

                  <div className="category-cards">

                    <button

                      type="button"

                      className={`category-card all-category ${

                        selectedCategory === '' ? 'active' : ''

                      }`}

                      onClick={() => setSelectedCategory('')}

                    >

                      <span className="category-card-icon">▦</span>

                      <strong>All Categories</strong>

                      <small>{books.length} books in catalog</small>

                    </button>

                    {categories.map((category, index) => {

                      const count = books.filter(

                        (book) =>

                          canonicalBookCategory(book.category || 'General', book.title) === category,

                      ).length;

                      return (

                        <button

                          type="button"

                          key={category}

                          className={`category-card category-color-${index % 5} ${

                            selectedCategory === category ? 'active' : ''

                          }`}

                          onClick={() => setSelectedCategory(category)}

                          aria-pressed={selectedCategory === category}

                        >

                          <span className="category-card-icon">▤</span>

                          <strong>{displayCategoryName(category)}</strong>

                          <small>

                            {count} {count === 1 ? 'book' : 'books'}

                          </small>

                          <span className="category-card-arrow">→</span>

                        </button>

                      );

                    })}

                  </div>

                  <div className="section-heading category-results-heading">

                    <div>

                      <span className="eyebrow">SELECTED CATEGORY</span>

                      <h2>{displayCategoryName(selectedCategory) || 'All Books'}</h2>

                    </div>

                    <IonBadge color="primary">

                      {filteredBooks.length} results

                    </IonBadge>

                  </div>

                  {booksLoading ? (

                    <div className="loading-row">

                      <IonSpinner name="crescent" />

                      <span>Loading books...</span>

                    </div>

                  ) : filteredBooks.length > 0 ? (

                    <div className="book-grid">

                      {filteredBooks.map((book, index) => (

                        <article key={book.id} className="book-tile">

                          <BookCover book={book} index={index} />

                          <div className="book-info">

                            <button

                              type="button"

                              className="book-category category-link"

                              onClick={() =>

                                setSelectedCategory(canonicalBookCategory(book.category || 'General', book.title))

                              }

                              disabled={!book.category?.trim()}

                            >

                              {displayCategoryName(book.category || 'General', book.title)}

                            </button>

                            <h3>{book.title}</h3>

                            <p><AuthorDisplay book={book} prefix="by " /></p>

                            {book.call_number && (
                              <p className="book-call-number">Call Number: {book.call_number}</p>
                            )}

                            {!isAdmin ? (
                              <>
                                <div className="book-availability-row">
                                  <span className={book.available_copies > 0 ? 'book-available' : 'book-unavailable'}>
                                    {book.available_copies} available
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => toggleSavedBook(book.id)}
                                    aria-label={savedBookIds.includes(book.id) ? 'Remove from saved books' : 'Add to saved books'}
                                    title={savedBookIds.includes(book.id) ? 'Remove from saved books' : 'Add to saved books'}
                                    style={{ width:28, height:28, padding:0, border:0, background:'transparent', color:savedBookIds.includes(book.id) ? '#d49a16' : '#8795a7', fontSize:21, lineHeight:1, cursor:'pointer' }}
                                  >
                                    {savedBookIds.includes(book.id) ? '★' : '☆'}
                                  </button>
                                </div>
                                <div className="book-card-actions">
                                  <IonButton
                                    expand="block"
                                    fill="outline"
                                    className="book-details-button"
                                    onClick={() => setSelectedBook(book)}
                                  >
                                    Details
                                  </IonButton>
                                  <IonButton
                                    expand="block"
                                    className="borrow-book-button"
                                    disabled={!isBorrowingScheduleOpenNow() || !book.available || book.available_copies < 1 || loading}
                                    onClick={() => void borrowBook(book)}
                                  >
                                    {loading ? 'Processing...' : book.available && book.available_copies > 0 ? 'Request' : 'Unavailable'}
                                  </IonButton>
                                </div>
                              </>
                            ) : (
                              <div className="book-meta">
                                <IonBadge color={book.available ? 'success' : 'medium'}>
                                  {book.available ? `${book.available_copies} available` : 'Unavailable'}
                                </IonBadge>
                                <span>{book.available_copies}/{book.total_copies} copies</span>
                              </div>
                            )}
                          </div>
                        </article>
                      ))}

                    </div>

                  ) : (

                    <div className="empty-state">

                      <span>⌕</span>

                      <h3>No books found</h3>

                      <p>

                        {selectedCategory

                          ? `No books found in "${selectedCategory}".`

                          : 'Try a different search.'}

                      </p>

                      {selectedCategory && (

                        <IonButton

                          fill="outline"

                          onClick={() => setSelectedCategory('')}

                        >

                          Show All Categories

                        </IonButton>

                      )}

                    </div>

                  )}

                </section>

              )}

              {page === 'home' && isStudent && isPhilippineWeekend() && (
                <div
                  role="status"
                  aria-live="polite"
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '12px',
                    margin: '14px 0 18px',
                    padding: '15px 17px',
                    border: '1px solid #f1d39a',
                    borderLeft: '5px solid #d99a2b',
                    borderRadius: '14px',
                    background: '#fff8e8',
                    color: '#684b18',
                    lineHeight: 1.55,
                  }}
                >
                  <span aria-hidden="true" style={{ fontSize: '22px' }}>🗓️</span>
                  <div>
                    <strong style={{ display: 'block', marginBottom: '4px' }}>
                      No Book Borrowing on Saturdays and Sundays
                    </strong>
                    <span>
                      Book borrowing is not available on Saturdays and Sundays.
                      Please visit the library during regular operating days (Monday-Friday).
                    </span>
                  </div>
                </div>
              )}

              {/* BOOK CATALOG AND MANAGEMENT */}

              {(page === 'books' || (page === 'home' && !isAdmin)) && (

                <section className="catalog-section home-embedded-catalog">

                  <div className="section-heading">

                    <div>

                      <span className="eyebrow">

                        {isAdmin ? 'CATALOG MANAGEMENT' : 'FIND YOUR NEXT READ'}

                      </span>

                      {(isAdmin || page === 'books') && (
                        <h2>{isAdmin ? 'Book Inventory' : 'Book Catalog'}</h2>
                      )}

                      <p>

                        {isAdmin

                          ? 'Review, add, edit, and delete book records.'

                          : 'Search books and check availability.'}

                      </p>

                    </div>

                    {isAdmin && (

                      <IonButton

                        className="gold-button"

                        onClick={() => void saveBook()}

                        disabled={savingBook}

                      >

                        {savingBook ? (

                          <IonSpinner name="crescent" />

                        ) : (

                          '+ Add Book'

                        )}

                      </IonButton>

                    )}

                  </div>

                  {page === 'books' && isStudent && isPhilippineWeekend() && (
                    <div
                      role="status"
                      aria-live="polite"
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '12px',
                        margin: '14px 0 18px',
                        padding: '15px 17px',
                        border: '1px solid #f1d39a',
                        borderLeft: '5px solid #d99a2b',
                        borderRadius: '14px',
                        background: '#fff8e8',
                        color: '#684b18',
                        lineHeight: 1.55,
                      }}
                    >
                      <span aria-hidden="true" style={{ fontSize: '22px' }}>🗓️</span>
                      <div>
                        <strong style={{ display: 'block', marginBottom: '4px' }}>
                          No Book Borrowing on Saturdays and Sundays
                        </strong>
                        <span>
                          Book borrowing is not available on Saturdays and Sundays.
                          Please visit the library during regular operating days (Monday-Friday).
                        </span>
                      </div>
                    </div>
                  )}

                  <IonSearchbar

                    value={query}

                    onIonInput={(e) => setQuery(e.detail.value || '')}

                    placeholder="Search books or authors..."

                  />

                  <div className="category-filter">

                    <button

                      type="button"

                      className={`category-chip ${

                        selectedCategory === '' ? 'active' : ''

                      }`}

                      onClick={() => setSelectedCategory('')}

                    >

                      All Categories

                    </button>

                    {categories.map((category) => (

                      <button

                        type="button"

                        key={category}

                        className={`category-chip ${

                          selectedCategory === category ? 'active' : ''

                        }`}

                        onClick={() => setSelectedCategory(category)}

                      >

                        {displayCategoryName(category)}

                      </button>

                    ))}

                  </div>

                  {booksLoading ? (

                    <div className="loading-row">

                      <IonSpinner name="crescent" />

                      <span>Loading catalog...</span>

                    </div>

                  ) : filteredBooks.length > 0 && isAdmin ? (

                    <div className="admin-table-wrap">

                      <table className="admin-book-table">

                        <thead>

                          <tr>

                            <th>Book title</th>

                            <th>Author</th>

                            <th>Category</th>

                            <th>Copies</th>

                            <th>Status</th>

                            <th>Actions</th>

                          </tr>

                        </thead>

                        <tbody>

                          {filteredBooks.map((book) => (

                            <tr key={book.id}>

                              <td>

                                <strong>{book.title}</strong>

                                <small>Book ID: {book.id}</small>

                              </td>

                              <td><AuthorDisplay book={book} /></td>

                              <td>{displayCategoryName(book.category || 'General', book.title)}</td>

                              <td>

                                {book.available_copies}/{book.total_copies}

                              </td>

                              <td>

                                <IonBadge

                                  color={book.available ? 'success' : 'medium'}

                                >

                                  {book.available ? 'Available' : 'Unavailable'}

                                </IonBadge>

                              </td>

                              <td>

                                <div className="inventory-actions">

                                  <IonButton

                                    size="small"

                                    fill="outline"

                                    onClick={() => void saveBook(book)}

                                    disabled={savingBook}

                                  >

                                    Edit

                                  </IonButton>

                                  <IonButton

                                    size="small"

                                    color="danger"

                                    fill="outline"

                                    onClick={() => void deleteBook(book)}

                                  >

                                    Delete

                                  </IonButton>

                                </div>

                              </td>

                            </tr>

                          ))}

                        </tbody>

                      </table>

                    </div>

                  ) : filteredBooks.length > 0 ? (

                    <div className="book-grid">

                      {filteredBooks.map((book, index) => (

                        <article key={book.id} className="book-tile">

                          <BookCover book={book} index={index} />

                          <div className="book-info">

                            <button

                              type="button"

                              className="book-category category-link"

                              onClick={() => {

                                setSelectedCategory(canonicalBookCategory(book.category || 'General', book.title));

                                setPage('categories');

                              }}

                            >

                              {displayCategoryName(book.category || 'General', book.title)}

                            </button>

                            <h3>{book.title}</h3>

                            <p><AuthorDisplay book={book} prefix="by " /></p>

                            <div className="book-meta">

                              <IonBadge

                                color={book.available ? 'success' : 'medium'}

                              >

                                {book.available

                                  ? `${book.available_copies} available`

                                  : 'Unavailable'}

                              </IonBadge>

                              <span>

                                {book.available_copies}/{book.total_copies} copies

                              </span>

                            </div>

                            <button
                              type="button"
                              onClick={() => setSelectedBook(book)}
                              style={{ marginTop: '14px', border: '1px solid #b99a62', borderRadius: '10px', padding: '9px 12px', background: 'transparent', color: 'inherit', cursor: 'pointer', fontWeight: 600 }}
                            >
                              View About This Book →
                            </button>

                          </div>

                        </article>

                      ))}

                    </div>

                  ) : (

                    <div className="empty-state">

                      <h3>No books found</h3>

                      <p>Try a different search or category.</p>

                    </div>

                  )}



                </section>

              )}

              {/* ALL REGISTERED ACCOUNTS */}

              {false && page === 'accounts' && isAdmin && (

                <section className="logged-in-section">

                  <div className="logged-in-heading">

                    <div>

                      <span className="eyebrow">USER MANAGEMENT</span>

                      <h2>All Registered Accounts</h2>

                    </div>

                    <IonBadge color="primary">

                      {accounts.length} Total Accounts

                    </IonBadge>

                  </div>

                  <IonSearchbar

                    value={accountQuery}

                    onIonInput={(e) =>

                      setAccountQuery(e.detail.value || '')

                    }

                    placeholder="Search name or email..."

                  />

                  {accountsError && (

                    <IonText color="danger">

                      <p role="alert">

                        Could not load accounts: {accountsError}

                      </p>

                    </IonText>

                  )}

                  {accountsLoading && accounts.length === 0 ? (

                    <div className="sessions-loading">

                      <IonSpinner name="crescent" />

                      <span>Loading all accounts...</span>

                    </div>

                  ) : (

                    <div className="sessions-table-wrap">

                      <table className="sessions-table">

                        <thead>

                          <tr>

                            <th>Account</th>

                            <th>School ID</th>

                            <th>Course</th>

                            <th>Year</th>

                            <th>Section</th>

                            <th>Email</th>

                            <th>Role</th>

                            <th>Status</th>

                            <th>Action</th>

                          </tr>

                        </thead>

                        <tbody>

                          {filteredAccounts.map((account) => {

                            const online = isAccountOnline(account);

                            return (

                              <tr key={account.id}>

                                <td>

                                  <strong>{account.full_name}</strong>

                                  <small>{account.username ? `@${account.username}` : account.role === 'admin' ? 'Administrator' : account.role?.toLowerCase() === 'faculty' ? 'Faculty account' : 'Student account'}</small>

                                </td>

                                <td>{account.student_id?.trim() || '—'}</td>

                                <td>{account.course?.trim() || '—'}</td>

                                <td>{account.year?.trim() || '—'}</td>

                                <td>{account.section?.trim() || '—'}</td>

                                <td>{account.email}</td>

                                <td>

                                  <IonBadge

                                    color={

                                      account.role.toLowerCase() === 'admin'

                                        ? 'warning'

                                        : 'medium'

                                    }

                                  >

                                    {account.role}

                                  </IonBadge>

                                </td>

                                <td>

                                  {online ? (

                                    <span className="session-online">

                                      <span className="session-online-dot" />

                                      Online

                                    </span>

                                  ) : (

                                    <span className="session-offline">

                                      <span className="session-offline-dot" />

                                      Offline

                                    </span>

                                  )}

                                </td>
                                <td>
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                                    <IonButton
                                      size="small"
                                      color="danger"
                                      fill="outline"
                                      disabled={deletingAccountId === account.id || (!!user && account.id === user.id)}
                                      onClick={() => deleteAccount(account)}
                                    >
                                      {deletingAccountId === account.id ? 'Deleting...' : 'Delete'}
                                    </IonButton>
                                  </div>
                                </td>

                              </tr>

                            );

                          })}

                          {filteredAccounts.length === 0 && (

                            <tr>

                              <td colSpan={7} className="sessions-empty">

                                {accounts.length === 0

                                  ? 'No registered accounts yet.'

                                  : 'No accounts match your search.'}

                              </td>

                            </tr>

                          )}

                        </tbody>

                      </table>

                    </div>

                  )}

                </section>

              )}

              {/* ACTIVE LOGIN SESSIONS */}

              {false && page === 'sessions' && isAdmin && (

                <section className="logged-in-section">

                  <div className="logged-in-heading">

                    <div>

                      <span className="eyebrow">ACCOUNT MONITORING</span>

                      <h2>Logged-in Accounts</h2>

                      <p>

                        Accounts with recent activity in the last 90 seconds.

                      </p>

                    </div>

                    <IonBadge color="success">

                      {loginSessions.length} Online

                    </IonBadge>

                  </div>

                  {sessionsError && (

                    <IonText color="danger">

                      <p role="alert">

                        Could not retrieve sessions: {sessionsError}

                      </p>

                    </IonText>

                  )}

                  {sessionsLoading && loginSessions.length === 0 ? (

                    <div className="sessions-loading">

                      <IonSpinner name="crescent" />

                      <span>Loading logged-in accounts...</span>

                    </div>

                  ) : (

                    <div className="sessions-table-wrap">

                      <table className="sessions-table">

                        <thead>

                          <tr>

                            <th>Account</th>

                            <th>School ID</th>

                            <th>Course</th>

                            <th>Email</th>

                            <th>Role</th>

                            <th>Status</th>

                            <th>Last Activity</th>

                          </tr>

                        </thead>

                        <tbody>

                          {loginSessions.length === 0 ? (

                            <tr>

                              <td colSpan={7} className="sessions-empty">

                                {sessionsError

                                  ? 'Could not load the account list.'

                                  : 'There are no active sessions right now.'}

                              </td>

                            </tr>

                          ) : (

                            loginSessions.map((session) => {
                              const account = accounts.find((item) => item.id === session.user_id);
                              return (
                                <tr key={`${session.user_id}-${session.login_at}`}>
                                  <td><strong>{session.full_name}</strong></td>
                                  <td>{account?.student_id?.trim() || '—'}</td>
                                  <td>{account?.course?.trim() || '—'}</td>
                                  <td>{session.email}</td>
                                  <td>
                                    <IonBadge color={session.role.toLowerCase() === 'admin' ? 'warning' : 'medium'}>
                                      {session.role}
                                    </IonBadge>
                                  </td>
                                  <td>
                                    <span className="session-online">
                                      <span className="session-online-dot" />
                                      {session.status}
                                    </span>
                                  </td>
                                  <td>{formatPhilippineTime(session.last_seen)}</td>
                                </tr>
                              );
                            })

                          )}

                        </tbody>

                      </table>

                    </div>

                  )}

                </section>

              )}

              {borrowRequestConfirmation && (
                <div
                  role="presentation"
                  onClick={() => setBorrowRequestConfirmation(null)}
                  style={{ position: 'fixed', inset: 0, zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', background: 'rgba(15, 23, 42, 0.62)', backdropFilter: 'blur(4px)' }}
                >
                  <section
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="borrow-request-title"
                    onClick={(event) => event.stopPropagation()}
                    style={{ width: '100%', maxWidth: '430px', background: 'var(--ion-card-background, #ffffff)', color: 'var(--ion-text-color, #172033)', borderRadius: '20px', padding: '28px', boxShadow: '0 24px 70px rgba(0,0,0,0.28)' }}
                  >
                    <h2 id="borrow-request-title" style={{ textAlign: 'center', margin: '0 0 12px', fontSize: '22px' }}>Confirm Borrowing</h2>
                    <p style={{ textAlign: 'center', margin: '0 0 12px', lineHeight: 1.55 }}>
                      Do you want to borrow <strong>“{borrowRequestConfirmation.title}”</strong> by {borrowRequestConfirmation.author}?
                    </p>
                    <p style={{ textAlign: 'center', margin: '0 0 22px', lineHeight: 1.55, opacity: 0.78 }}>
                      If you confirm, your request will be sent to the admin. The admin will set your return due date.
                    </p>
                    <div style={{ display: 'flex', gap: '10px' }}>
                      <IonButton expand="block" fill="outline" color="medium" style={{ flex: 1, margin: 0 }} onClick={() => setBorrowRequestConfirmation(null)} disabled={loading}>
                        Cancel
                      </IonButton>
                      <IonButton expand="block" style={{ flex: 1, margin: 0, '--background': '#e8c15a', '--background-hover': '#d8ad43', '--color': '#17283f', '--box-shadow': '0 5px 13px rgba(191,148,49,.22)' } as React.CSSProperties} disabled={loading} onClick={() => {
                        const book = borrowRequestConfirmation;
                        if (book) void submitBorrowRequest(book);
                      }}>
                        {loading ? 'Processing…' : 'Borrow'}
                      </IonButton>
                    </div>
                  </section>
                </div>
              )}

              {pickupConfirmation && (
                <div
                  role="presentation"
                  onClick={() => setPickupConfirmation(null)}
                  style={{
                    position: 'fixed', inset: 0, zIndex: 10000,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: '20px', background: 'rgba(15, 32, 52, 0.68)',
                    backdropFilter: 'blur(6px)',
                  }}
                >
                  <section
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="pickup-modal-title"
                    onClick={(event) => event.stopPropagation()}
                    style={{
                      width: '100%', maxWidth: '430px', background: 'var(--ion-card-background, #ffffff)',
                      color: '#203047', borderRadius: '20px',
                      padding: '28px', border: '1px solid #e3e9ef', borderTop: '5px solid #e7c15b', boxShadow: '0 24px 70px rgba(18,39,63,0.28)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                      <div style={{
                        width: '64px', height: '64px', borderRadius: '50%',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'rgba(232, 193, 90, 0.22)', color: '#17283f', fontSize: '30px', border: '1px solid rgba(195,155,62,.25)',
                      }} aria-hidden="true">✓</div>
                    </div>
                    <h2 id="pickup-modal-title" style={{ textAlign: 'center', margin: '0 0 8px', fontSize: '22px' }}>
                      Confirm Book Pickup
                    </h2>
                    <p style={{ textAlign: 'center', margin: '0 0 20px', lineHeight: 1.55, opacity: 0.78 }}>
                      Please confirm that the student has arrived at the library and has received the book.
                    </p>
                    <label htmlFor="admin-approval-due-date" style={{ display: 'block', fontWeight: 600, marginBottom: '8px' }}>
                      Return Due Date
                    </label>
                    <input
                      id="admin-approval-due-date"
                      type="date"
                      min={(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })()}
                      max={(() => { const d = new Date(); d.setDate(d.getDate() + 7); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })()}
                      value={approvalDueDate}
                      onChange={(event) => setApprovalDueDate(event.target.value)}
                      style={{ width: '100%', boxSizing: 'border-box', padding: '12px', marginBottom: '18px', border: '1px solid var(--ion-color-medium, #92949c)', borderRadius: '10px', background: 'var(--ion-background-color, #fff)', color: 'var(--ion-text-color, #172033)', font: 'inherit' }}
                    />
                    <div style={{
                      padding: '14px 16px', borderRadius: '12px', marginBottom: '22px',
                      background: 'var(--ion-color-light, #f4f6f9)', lineHeight: 1.5,
                    }}>
                      <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', opacity: 0.65, marginBottom: '5px' }}>
                        IMPORTANT
                      </div>
                      Confirming will mark this request as borrowed and update the available book copies.
                    </div>
                    <div style={{ display: 'flex', gap: '10px' }}>
                      <IonButton
                        expand="block"
                        fill="outline"
                        color="medium"
                        style={{ flex: 1, margin: 0 }}
                        onClick={() => setPickupConfirmation(null)}
                        disabled={loading}
                      >
                        Cancel
                      </IonButton>
                      <IonButton
                        expand="block"
                        style={{ flex: 1, margin: 0, '--background': '#e8c15a', '--background-hover': '#d8ad43', '--color': '#17283f', '--box-shadow': '0 5px 13px rgba(191,148,49,.22)' } as React.CSSProperties}
                        onClick={() => {
                          const record = pickupConfirmation;
                          if (record) void approveBorrowing(record, approvalDueDate);
                          setPickupConfirmation(null);
                        }}
                        disabled={loading}
                      >
                        {loading ? 'Processing…' : 'Confirm Pickup'}
                      </IonButton>
                    </div>
                  </section>
                </div>
              )}

              {returnConfirmation && (
                <div role="presentation" onClick={() => setReturnConfirmation(null)} style={{
                  position: 'fixed', inset: 0, zIndex: 10001, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', padding: '20px', background: 'rgba(15, 32, 52, 0.68)',
                  backdropFilter: 'blur(6px)',
                }}>
                  <section role="dialog" aria-modal="true" aria-labelledby="return-modal-title"
                    onClick={(event) => event.stopPropagation()} style={{
                      width: '100%', maxWidth: '430px', background: 'var(--ion-card-background, #ffffff)',
                      color: '#203047', borderRadius: '20px', padding: '28px', border: '1px solid #e3e9ef', borderTop: '5px solid #e7c15b',
                      boxShadow: '0 24px 70px rgba(18,39,63,0.28)',
                    }}>
                    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                      <div style={{ width: '64px', height: '64px', borderRadius: '50%', display: 'flex',
                        alignItems: 'center', justifyContent: 'center', background: 'rgba(232, 193, 90, 0.22)',
                        color: '#17283f', fontSize: '30px', border: '1px solid rgba(195,155,62,.25)' }} aria-hidden="true">✓</div>
                    </div>
                    <h2 id="return-modal-title" style={{ textAlign: 'center', margin: '0 0 8px', fontSize: '22px' }}>Confirm Book Return</h2>
                    <p style={{ textAlign: 'center', margin: '0 0 20px', lineHeight: 1.55, opacity: 0.78 }}>
                      Has the student physically returned this book to the library?
                    </p>
                    <div style={{ padding: '14px 16px', borderRadius: '12px', marginBottom: '22px',
                      background: 'var(--ion-color-light, #f4f6f9)', lineHeight: 1.5 }}>
                      <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', opacity: 0.65, marginBottom: '5px' }}>IMPORTANT</div>
                      Confirming will mark this loan as returned and increase the available book copies.
                    </div>
                    <div style={{ display: 'flex', gap: '10px' }}>
                      <IonButton expand="block" fill="outline" color="medium" style={{ flex: 1, margin: 0 }}
                        onClick={() => setReturnConfirmation(null)} disabled={loading}>Cancel</IonButton>
                      <IonButton expand="block" style={{ flex: 1, margin: 0, '--background': '#e8c15a', '--background-hover': '#d8ad43', '--color': '#17283f', '--box-shadow': '0 5px 13px rgba(191,148,49,.22)' } as React.CSSProperties} disabled={loading}
                        onClick={() => { const record = returnConfirmation; setReturnConfirmation(null); if (record) void returnBorrowing(record); }}>
                        {loading ? 'Processing…' : 'Confirm Return'}
                      </IonButton>
                    </div>
                  </section>
                </div>
              )}

              {receiptPreviewCase && (
                <div role="presentation" onClick={() => setReceiptPreviewCase(null)} style={{ position:'fixed', inset:0, zIndex:14000, display:'grid', placeItems:'center', padding:16, background:'rgba(7,24,43,.72)', backdropFilter:'blur(5px)' }}>
                  <section role="dialog" aria-modal="true" aria-labelledby="case-receipt-title" onClick={event=>event.stopPropagation()} style={{ width:'min(100%,460px)', maxHeight:'90vh', overflowY:'auto', background:'#fff', color:'#172b45', borderRadius:18, padding:22, boxShadow:'0 24px 70px rgba(10,30,52,.35)' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, marginBottom:16 }}>
                      <div>
                        <div style={{ color:'#b18425', fontSize:10, fontWeight:800, letterSpacing:'.12em' }}>NEUST PEÑARANDA OFF-CAMPUS</div>
                        <h2 id="case-receipt-title" style={{ margin:'4px 0 0', fontSize:21, fontWeight:850 }}>
                          {receiptPreviewCase.resolution_status === 'paid' ? 'Payment Receipt' : 'Book Replacement Receipt'}
                        </h2>
                      </div>
                      <button type="button" onClick={()=>setReceiptPreviewCase(null)} aria-label="Close receipt preview" style={{ border:0, borderRadius:10, width:38, height:38, background:'#eef2f7', color:'#243b55', fontSize:22, cursor:'pointer' }}>×</button>
                    </div>
                    <div style={{ textAlign:'center', padding:'16px 10px', borderTop:'1px dashed #cbd5e1', borderBottom:'1px dashed #cbd5e1', marginBottom:14 }}>
                      <div style={{ width:52, height:52, borderRadius:'50%', display:'grid', placeItems:'center', margin:'0 auto 9px', background:'#e7f7ed', color:'#16834b', fontSize:27, fontWeight:800 }}>✓</div>
                      <div style={{ color:'#16834b', fontWeight:800, fontSize:17 }}>
                        {receiptPreviewCase.resolution_status === 'paid' ? 'PAYMENT RECORDED' : 'REPLACEMENT RECEIVED'}
                      </div>
                      <div style={{ color:'#718096', fontSize:12, marginTop:4 }}>Case #{receiptPreviewCase.id} · {receiptPreviewCase.resolved_at ? new Date(receiptPreviewCase.resolved_at).toLocaleString() : 'Resolution recorded'}</div>
                    </div>
                    <div style={{ display:'grid', gap:10, fontSize:14 }}>
                      <div style={{ display:'flex', justifyContent:'space-between', gap:12 }}><span style={{ color:'#718096' }}>Case type</span><strong>{receiptPreviewCase.case_type.toUpperCase()}</strong></div>
                      <div style={{ display:'flex', justifyContent:'space-between', gap:12 }}><span style={{ color:'#718096' }}>Case amount due</span><strong>₱{Number(receiptPreviewCase.amount_due || 0).toFixed(2)}</strong></div>
                      {(receiptPreviewCase.resolution_note || '').split(' | ').filter(Boolean).map((entry, index) => {
                        const separator = entry.indexOf(':');
                        const label = separator >= 0 ? entry.slice(0, separator) : 'Details';
                        const value = separator >= 0 ? entry.slice(separator + 1).trim() : entry;
                        return <div key={`${index}-${label}`} style={{ display:'flex', justifyContent:'space-between', gap:12, borderTop:'1px solid #edf1f5', paddingTop:9 }}>
                          <span style={{ color:'#718096' }}>{label}</span><strong style={{ textAlign:'right', maxWidth:'58%', overflowWrap:'anywhere' }}>{value}</strong>
                        </div>;
                      })}
                    </div>
                    {receiptPreviewCase.resolution_note?.includes('Receipt Attachment:') && (
                      <button type="button" disabled={receiptAttachmentLoading} onClick={()=>void viewReceiptAttachment(receiptPreviewCase)} style={{ width:'100%', marginTop:14, padding:12, border:'1px solid #c7d8eb', borderRadius:10, background:'#f8fbff', color:'#174a78', fontWeight:750, cursor:'pointer' }}>
                        {receiptAttachmentLoading ? 'Opening attachment...' : 'View Receipt Attachment'}
                      </button>
                    )}
                    {receiptPreviewCase.resolution_note?.includes('Receipt Attachment:') && !receiptPreviewCase.resolution_note?.includes('Receipt Storage Key:') && (
                      <div style={{ marginTop:10, padding:12, border:'1px solid #f2d39a', borderRadius:10, background:'#fffaf0' }}>
                        <div style={{ color:'#925b08', fontSize:12, lineHeight:1.45, marginBottom:9 }}>
                          This older record only saved the filename, not the actual image. Select the original receipt file again to securely save it and enable the preview.
                        </div>
                        <label style={{ display:'block', color:'#344b63', fontSize:12, fontWeight:750, marginBottom:7 }}>Upload receipt image or PDF</label>
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp,application/pdf"
                          disabled={receiptReuploadLoading}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) void reuploadReceiptAttachment(receiptPreviewCase, file);
                            event.currentTarget.value = '';
                          }}
                          style={{ display:'block', width:'100%', fontSize:12 }}
                        />
                        {receiptReuploadLoading && <div style={{ marginTop:8, color:'#174a78', fontSize:12 }}>Uploading receipt securely...</div>}
                      </div>
                    )}
                    {receiptAttachmentUrl && (
                      <div style={{ marginTop:12, padding:10, border:'1px solid #dbe4ee', borderRadius:12, background:'#f8fafc' }}>
                        {receiptAttachmentUrl && (receiptPreviewCase.resolution_note || '').match(/\.(pdf)\b/i) ? (
                          <iframe title="Receipt attachment preview" src={receiptAttachmentUrl} style={{ width:'100%', height:420, border:0, borderRadius:8 }} />
                        ) : (
                          <img src={receiptAttachmentUrl} alt="Uploaded receipt attachment" style={{ display:'block', width:'100%', maxHeight:420, objectFit:'contain', borderRadius:8, background:'#fff' }} />
                        )}
                        <button type="button" onClick={()=>{ URL.revokeObjectURL(receiptAttachmentUrl); setReceiptAttachmentUrl(null); }} style={{ width:'100%', marginTop:8, padding:9, border:0, borderRadius:9, background:'#e8eef5', color:'#243b55', fontWeight:700, cursor:'pointer' }}>Close Attachment</button>
                      </div>
                    )}
                    <div style={{ marginTop:18, padding:12, borderRadius:10, background:'#f0f6ff', color:'#315a8a', fontSize:12, lineHeight:1.45 }}>
                      {receiptPreviewCase.resolution_status === 'paid'
                        ? 'This is a LibTrack payment record preview. Keep the original official GCash, bank, or cash receipt as proof of payment.'
                        : 'This is a LibTrack replacement acknowledgment. Keep the original library record for verification.'}
                    </div>
                    <button type="button" onClick={()=>setReceiptPreviewCase(null)} style={{ width:'100%', marginTop:16, padding:12, border:0, borderRadius:10, background:'#173b59', color:'#fff', fontWeight:750, cursor:'pointer' }}>Close Preview</button>
                  </section>
                </div>
              )}

              {lostBookDialog && (
                <div role="presentation" onClick={() => !loading && setLostBookDialog(null)} style={{ position:'fixed', inset:0, zIndex:13000, display:'grid', placeItems:'center', padding:20, background:'rgba(7,24,43,.68)', backdropFilter:'blur(5px)' }}>
                  <section role="dialog" aria-modal="true" aria-labelledby="lost-book-dialog-title" onClick={(event)=>event.stopPropagation()} style={{ width:'min(100%,500px)', maxHeight:'90vh', overflowY:'auto', background:'var(--ion-card-background,#fff)', color:'var(--ion-text-color,#18324d)', borderRadius:20, padding:26, border:'1px solid #dce5ef', borderTop:'5px solid #e8c15a', boxShadow:'0 24px 70px rgba(10,30,52,.32)' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:8 }}>
                      <div style={{ width:46, height:46, flex:'0 0 46px', borderRadius:14, display:'grid', placeItems:'center', background:'#fff5dc', fontSize:23 }}>📚</div>
                      <div><div style={{ color:'#b18425', fontSize:10, fontWeight:800, letterSpacing:'.12em' }}>NEUST LIBRARY POLICY · SECTION 8.6</div>
                        <h2 id="lost-book-dialog-title" style={{ margin:'3px 0 0', fontSize:21, fontWeight:800 }}>{lostBookDialog.mode==='report' ? `Report ${lostBookDialog.caseType==='damaged'?'Damaged':'Lost'} Book` : `Confirm Case ${lostBookDialog.resolution==='paid'?'Payment':'Replacement'}`}</h2></div>
                    </div>
                    <p style={{ margin:'0 0 20px', color:'var(--ion-color-medium,#718096)', lineHeight:1.5, fontSize:13 }}>
                      {lostBookDialog.mode==='report' ? 'Enter the book value and any additional fine to record this case.' : `Add an optional receipt or reference note before marking case #${lostBookDialog.item?.id} as ${lostBookDialog.resolution}.`}
                    </p>
                    {lostBookDialog.mode==='report' && <div style={{ display:'grid', gap:14 }}>
                      <label style={{ display:'grid', gap:6, fontSize:13, fontWeight:700 }}>Current market value (PHP)
                        <input type="number" min="0" step="0.01" value={lostBookMarketValue} onChange={e=>setLostBookMarketValue(e.target.value)} style={{ width:'100%', boxSizing:'border-box', padding:'13px 14px', borderRadius:10, border:'1px solid #cbd7e4', background:'var(--ion-background-color,#f7f9fc)', color:'inherit', font:'inherit' }} /></label>
                      <label style={{ display:'grid', gap:6, fontSize:13, fontWeight:700 }}>Additional fine (PHP)
                        <input type="number" min="0" step="0.01" value={lostBookAdditionalFine} onChange={e=>setLostBookAdditionalFine(e.target.value)} style={{ width:'100%', boxSizing:'border-box', padding:'13px 14px', borderRadius:10, border:'1px solid #cbd7e4', background:'var(--ion-background-color,#f7f9fc)', color:'inherit', font:'inherit' }} />
                        <small style={{ color:'var(--ion-color-medium,#718096)', fontWeight:400 }}>Total charges are capped at book value plus PHP 50.</small></label>
                    </div>}
                    {lostBookDialog.mode === 'report' ? (
                      <label style={{ display:'grid', gap:6, marginTop:14, fontSize:13, fontWeight:700 }}>Notes (optional)
                        <textarea rows={3} value={lostBookNote} onChange={e=>setLostBookNote(e.target.value)} placeholder="Enter a note..." style={{ width:'100%', boxSizing:'border-box', resize:'vertical', padding:'12px 14px', borderRadius:10, border:'1px solid #cbd7e4', background:'var(--ion-background-color,#f7f9fc)', color:'inherit', font:'inherit' }} /></label>
                    ) : (
                      <div style={{ display:'grid', gap:12, marginTop:14 }}>
                        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))', gap:12 }}>
                          <label style={{ display:'grid', gap:6, fontSize:13, fontWeight:700 }}>Receipt Number (optional)
                            <input value={lostBookReceiptNumber} onChange={e=>setLostBookReceiptNumber(e.target.value)} placeholder="e.g. OR-2026-001" style={{ width:'100%', boxSizing:'border-box', padding:'12px', borderRadius:10, border:'1px solid #cbd7e4', background:'var(--ion-background-color,#f7f9fc)', color:'inherit', font:'inherit' }} /></label>
                          {lostBookDialog.resolution === 'paid' ? <>
                            <label style={{ display:'grid', gap:6, fontSize:13, fontWeight:700 }}>Amount Paid (PHP) *
                              <input type="number" min="0.01" step="0.01" value={lostBookAmountPaid} onChange={e=>setLostBookAmountPaid(e.target.value)} placeholder="Enter amount paid" style={{ width:'100%', boxSizing:'border-box', padding:'12px', borderRadius:10, border:'1px solid #cbd7e4', background:'var(--ion-background-color,#f7f9fc)', color:'inherit', font:'inherit' }} /></label>
                            <label style={{ display:'grid', gap:6, fontSize:13, fontWeight:700 }}>Payment Date *
                              <input type="date" value={lostBookPaymentDate} onChange={e=>setLostBookPaymentDate(e.target.value)} style={{ width:'100%', boxSizing:'border-box', padding:'12px', borderRadius:10, border:'1px solid #cbd7e4', background:'var(--ion-background-color,#f7f9fc)', color:'inherit', font:'inherit' }} /></label>
                            <label style={{ display:'grid', gap:6, fontSize:13, fontWeight:700 }}>Payment Method *
                              <select value={lostBookPaymentMethod} onChange={e=>setLostBookPaymentMethod(e.target.value)} style={{ width:'100%', boxSizing:'border-box', padding:'12px', borderRadius:10, border:'1px solid #cbd7e4', background:'var(--ion-background-color,#f7f9fc)', color:'inherit', font:'inherit' }}>
                                <option>Cash</option><option>GCash</option><option>Bank Transfer</option><option>Other</option>
                              </select></label>
                          </> : <>
                            <label style={{ display:'grid', gap:6, fontSize:13, fontWeight:700 }}>Replacement Book Title *
                              <input value={lostBookReplacementTitle} onChange={e=>setLostBookReplacementTitle(e.target.value)} placeholder="Enter replacement book title" style={{ width:'100%', boxSizing:'border-box', padding:'12px', borderRadius:10, border:'1px solid #cbd7e4', background:'var(--ion-background-color,#f7f9fc)', color:'inherit', font:'inherit' }} /></label>
                            <label style={{ display:'grid', gap:6, fontSize:13, fontWeight:700 }}>Date Received *
                              <input type="date" value={lostBookReplacementDate} onChange={e=>setLostBookReplacementDate(e.target.value)} style={{ width:'100%', boxSizing:'border-box', padding:'12px', borderRadius:10, border:'1px solid #cbd7e4', background:'var(--ion-background-color,#f7f9fc)', color:'inherit', font:'inherit' }} /></label>
                            <label style={{ display:'grid', gap:6, fontSize:13, fontWeight:700 }}>Received / Checked By
                              <input value={lostBookReceivedBy} onChange={e=>setLostBookReceivedBy(e.target.value)} placeholder="Librarian name" style={{ width:'100%', boxSizing:'border-box', padding:'12px', borderRadius:10, border:'1px solid #cbd7e4', background:'var(--ion-background-color,#f7f9fc)', color:'inherit', font:'inherit' }} /></label>
                          </>}
                        </div>
                        <label style={{ display:'grid', gap:6, fontSize:13, fontWeight:700 }}>Upload Receipt (image or PDF, optional)
                          <input type="file" accept="image/*,application/pdf" onChange={e=>setLostBookReceiptFile(e.target.files?.[0] || null)} style={{ width:'100%', boxSizing:'border-box', padding:'10px', borderRadius:10, border:'1px solid #cbd7e4', background:'var(--ion-background-color,#f7f9fc)', color:'inherit', font:'inherit' }} />
                          {lostBookReceiptFile && <><small style={{ color:'#52708c', fontWeight:500 }}>Selected: {lostBookReceiptFile.name}</small>{lostBookReceiptFile.type.startsWith('image/') && <img src={URL.createObjectURL(lostBookReceiptFile)} alt="Selected receipt preview" style={{ width:'100%', maxHeight:180, objectFit:'contain', borderRadius:10, border:'1px solid #dbe4ee', background:'#fff' }} />}</>}
                        </label>
                        <label style={{ display:'grid', gap:6, fontSize:13, fontWeight:700 }}>Other Notes (optional)
                          <textarea rows={3} value={lostBookNote} onChange={e=>setLostBookNote(e.target.value)} placeholder="Enter a note..." style={{ width:'100%', boxSizing:'border-box', resize:'vertical', padding:'12px 14px', borderRadius:10, border:'1px solid #cbd7e4', background:'var(--ion-background-color,#f7f9fc)', color:'inherit', font:'inherit' }} /></label>
                        <small style={{ color:'#718096', lineHeight:1.45 }}>The selected receipt file will be securely uploaded to the private receipt-attachments bucket. Only the case owner and Admin can view it.</small>
                      </div>
                    )}
                    <div style={{ display:'flex', gap:10, marginTop:22 }}>
                      <IonButton expand="block" fill="outline" color="medium" style={{ flex:1, margin:0 }} disabled={loading} onClick={()=>setLostBookDialog(null)}>Cancel</IonButton>
                      <IonButton expand="block" style={{ flex:1, margin:0, '--background':'#173b59', '--background-hover':'#244e70', '--color':'#fff' } as React.CSSProperties} disabled={loading} onClick={()=>void submitLostBookDialog()}>{loading?'Saving...':lostBookDialog.mode==='report'?'Save Report':'Confirm'}</IonButton>
                    </div>
                  </section>
                </div>
              )}

                  {selectedBook && (
                    <div
                      role="dialog"
                      aria-modal="true"
                      aria-labelledby="book-about-title"
                      style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(15, 23, 42, 0.68)', display: 'grid', placeItems: 'center', padding: '20px', overflowY: 'auto' }}
                      onClick={(event) => {
                        if (event.target === event.currentTarget) setSelectedBook(null);
                      }}
                    >
                      <section style={{ position: 'relative', width: 'min(100%, 620px)', maxHeight: '90vh', overflowY: 'auto', background: 'var(--ion-background-color, #fff)', color: 'var(--ion-text-color, #222)', borderRadius: '20px', padding: '28px', boxShadow: '0 24px 80px rgba(0,0,0,.28)' }}>
                        <button
                          type="button"
                          onClick={() => setSelectedBook(null)}
                          aria-label="Close book details"
                          style={{ position: 'absolute', right: '16px', top: '10px', border: 0, background: 'transparent', fontSize: '30px', cursor: 'pointer', color: 'inherit' }}
                        >
                          ×
                        </button>
                        <div
                          className="book-cover-detail-frame"
                          style={{ boxShadow: '0 10px 26px rgba(15, 35, 55, .18)' }}
                        >
                          <BookCover
                            book={selectedBook}
                            index={selectedBook.id}
                            className="book-cover book-cover-detail"
                          />
                        </div>
                        <span className="eyebrow">ABOUT THIS BOOK</span>
                        <h2 id="book-about-title">{selectedBook.title}</h2>
                        <p style={{ color: '#8a6b35', marginTop: '4px' }}><AuthorDisplay book={selectedBook} prefix="by " /></p>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', margin: '18px 0' }}>
                          <span style={{ background: '#f3ead8', color: '#5f4722', borderRadius: '999px', padding: '6px 12px' }}>{displayCategoryName(selectedBook.category || 'General')}</span>
                          {selectedBook.call_number && <span>Call No.: {selectedBook.call_number}</span>}
                        </div>
                        <h3>About This Book</h3>
                        <BookAbout book={selectedBook} />
                        <p style={{ marginTop: '20px', fontWeight: 600 }}>
                          {selectedBook.available_copies > 0
                            ? `${selectedBook.available_copies} of ${selectedBook.total_copies} copies are currently available.`
                            : 'This book is currently unavailable.'}
                        </p>
                        <IonButton
                          expand="block"
                          onClick={() => {
                            setSelectedBook(null);
                            if (!isAdmin) navigate('categories');
                          }}
                        >
                          {isAdmin ? 'Back to Catalog' : 'Back to Categories'}
                        </IonButton>
                      </section>
                    </div>
                  )}

              {!userLoading && user && (
                <nav className="libtrack-mobile-bottom-nav" aria-label="Mobile navigation">
                  <button type="button" className={page === 'home' ? 'active' : ''} onClick={() => navigateFromBottom('home')}><span>⌂</span><span>Home</span></button>
                  <button type="button" className={(isAdmin ? page === 'borrowings' : page === 'categories') ? 'active' : ''} onClick={() => navigateFromBottom(isAdmin ? 'borrowings' : 'categories')}><span>{isAdmin ? '⇄' : '▦'}</span><span>{isAdmin ? 'Catalog' : 'Categories'}</span></button>
                  <button type="button" className={page === 'research' ? 'active' : ''} onClick={() => navigateFromBottom('research')}><span>▤</span><span>Research</span></button>
                  <button type="button" className={page === 'ebooks' ? 'active' : ''} onClick={() => { setSelectedEbook(null); navigateFromBottom('ebooks'); void loadEbooks(); }}><span>▣</span><span>E-Books</span></button>
                  <button type="button" className={page === 'settings' ? 'active' : ''} onClick={() => navigateFromBottom('settings')}><span>⚙</span><span>Settings</span></button>
                </nav>
              )}

              {profilePhotoPreview && (
                <div role="dialog" aria-modal="true" aria-label="Profile photo preview" onClick={() => setProfilePhotoPreview(null)} style={{ position: 'fixed', inset: 0, zIndex: 12000, display: 'grid', placeItems: 'center', padding: 24, background: 'rgba(3, 12, 24, .86)' }}>
                  <button type="button" aria-label="Close photo preview" onClick={() => setProfilePhotoPreview(null)} style={{ position: 'absolute', top: 20, right: 24, width: 42, height: 42, borderRadius: '50%', border: '1px solid rgba(255,255,255,.45)', background: 'rgba(255,255,255,.12)', color: '#fff', fontSize: 26, cursor: 'pointer' }}>×</button>
                  <div onClick={(event) => event.stopPropagation()} style={{ maxWidth: 'min(92vw, 760px)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                    <img src={profilePhotoPreview.url} alt={`${profilePhotoPreview.name} enlarged`} style={{ display: 'block', maxWidth: '100%', maxHeight: '78vh', objectFit: 'contain', borderRadius: 14, boxShadow: '0 18px 60px rgba(0,0,0,.45)' }} />
                    <span style={{ color: '#fff', fontWeight: 700, textAlign: 'center' }}>{profilePhotoPreview.name}</span>
                  </div>
                </div>
              )}

              {showWeekendNoticePopup && isStudent && (
                <div role="dialog" aria-modal="true" aria-labelledby="weekend-notice-title" style={{ position: 'fixed', inset: 0, zIndex: 10000, display: 'grid', placeItems: 'center', padding: '20px', background: 'rgba(5, 20, 38, .62)' }}>
                  <section style={{ width: 'min(100%, 440px)', padding: '26px', borderRadius: '20px', background: '#fff', boxShadow: '0 20px 60px rgba(0,0,0,.25)', textAlign: 'center' }}>
                    <div style={{ fontSize: '38px', marginBottom: '8px' }}>🗓️</div>
                    <h2 id="weekend-notice-title" style={{ margin: '0 0 10px', color: '#09284a', fontSize: '22px' }}>Weekend Borrowing Notice</h2>
                    <p style={{ margin: '0 0 20px', color: '#526b86', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{weekendNoticeMessage}</p>
                    <IonButton expand="block" onClick={() => setShowWeekendNoticePopup(false)}>Got it</IonButton>
                  </section>
                </div>
              )}

              <footer className="dashboard-footer">

                <span>

                  📚 <strong>NEUST LibTrack</strong> · Library Management System

                </span>


              </footer>

            </main>

          </div>

        </div>

      </IonContent>

    </IonApp>

  );

}

createRoot(document.getElementById('root')!).render(<App />);
