import type { KoreaderFormat } from './book-formats'

export type BookFormat =
  | KoreaderFormat
  | 'azw3'
  | 'azw6'
  | 'kfx'
  | 'kpf'
export type ViewName = 'workspace' | 'library' | 'sources' | 'notes' | 'transfers' | 'settings' | 'profile'
export type TransferMethod = 'usb' | 'cloud' | 'opds' | 'kindle-email' | 'native-cloud'
export type JobStatus =
  | 'queued'
  | 'waiting_device'
  | 'importing'
  | 'transferring'
  | 'verifying'
  | 'sent'
  | 'cloud_ready'
  | 'published'
  | 'email_submitted'
  | 'delivery_unknown'
  | 'native_cloud_ready'
  | 'failed'
  | 'cancelled'

export interface Candidate {
  id: string
  title: string
  author: string
  format: BookFormat
  filename: string
  bytes: number
  sha256: string
  createdAt: string
  source: string
  cover?: string
  description?: string
  language?: string
  chapters: number
  warnings: string[]
  library: boolean
  isSample?: boolean
  fromDevice?: boolean
  calibreId?: number
  progress: number
  location?: string
  collection?: string
  isbn?: string
  finished?: boolean
  deviceProgress?: number
  koreaderPosition?: string
  derivedFromId?: string
  derivedFromHash?: string
}

export interface StoredCandidate extends Candidate {
  path: string
  previewPath?: string
}

export interface TransferJob {
  id: string
  batchId?: string
  candidateId: string
  title: string
  sha256: string
  method: TransferMethod
  status: JobStatus
  progress: number
  createdAt: string
  target: string
  cloudAccountId?: string
  remotePath?: string
  error?: string
  message?: string
  verifiedAt?: string
  deviceReceivedAt?: string
  mailRevision?: string
}

export interface LibraryCloudSync {
  id: string
  accountId: string
  working: boolean
  total: number
  prepared: number
  queued: number
  skipped: number
  currentTitle?: string
  failures: { candidateId: string; title: string; error: string }[]
  error?: string
}

export interface DownloadTask {
  id: string
  label: string
  bytes: number
  total: number
  status: 'downloading' | 'checking' | 'complete' | 'failed'
  error?: string
}

export interface DeviceInfo {
  id: string
  name: string
  freeBytes?: number
  capacityBytes?: number
}

export interface CloudAccount {
  id: string
  name: string
  provider: 'drive' | 'onedrive'
  connected: boolean
  checkedAt?: string
  error?: string
}
export interface CloudEntry {
  name: string
  path: string
  size: number
  isDir: boolean
  id?: string
  modifiedAt?: string
}
export interface CloudMutation {
  action: 'mkdir' | 'move' | 'trash' | 'write'
  path: string
  destination?: string
  text?: string
  expectedHash?: string
}
export interface SourceBook {
  id: string
  hash?: string
  name: string
  authors?: string[]
  extension?: string
  language?: string
  size?: string
  year?: string
  publisher?: string
}

export interface SourceEndpoint {
  origin: string
  resolvedOrigin?: string
  status: 'unknown' | 'checking' | 'online' | 'offline' | 'blocked'
  checkedAt?: string
  latencyMs?: number
  detail?: string
}
export interface SourceHealth {
  checking: boolean
  checkedAt?: string
  entries: SourceEndpoint[]
  activeOrigin?: string
}
export interface SourceAccount {
  status: 'signed_out' | 'unverified' | 'verifying' | 'connected' | 'expired' | 'unavailable'
  origin?: string
  checkedAt?: string
  remaining?: number
  dailyLimit?: number
  error?: string
}
export interface NoteAnchor {
  format: 'epub' | 'pdf'
  page?: number
  cfi?: string
  quote?: string
  prefix?: string
  suffix?: string
  sourcePosition?: string
  endPosition?: string
  fileHash?: string
}
export interface ReadingNote {
  id: string
  bookTitle: string
  author?: string
  text: string
  note?: string
  kind: 'highlight' | 'note' | 'bookmark'
  location?: string
  addedAt?: string
  source: 'kindle' | 'koreader'
  bookId?: string
  bookHash?: string
  anchor?: NoteAnchor
  origin?: { relative: string; deviceId?: string; identity: string; revision: string; text: string; note?: string; deleted?: boolean }
  edit?: { note: string; deleted: boolean; updatedAt: string; status: 'local' | 'queued' | 'uploaded' | 'applied' | 'conflict'; jobId?: string; error?: string }
}
export interface Notebook {
  id: string
  title: string
  sha256: string
  bytes: number
  importedAt: string
  status: 'original' | 'converting' | 'ready' | 'failed'
  format: 'nbk' | 'pdf'
  pages?: number
  location?: string
  error?: string
  thumbnail?: string
  classification?: 'notebook' | 'attachment' | 'auxiliary' | 'unknown'
  identity?: string
  titleSource?: 'device' | 'metadata' | 'manual' | 'unresolved'
}
export interface StoredNotebook extends Notebook {
  path: string
  pdfPath?: string
  pdfHash?: string
  sourceKey: string
}
export interface NotesImport {
  working: boolean
  notebooks: number
  annotations: number
  files: number
  message: string
  unreadable?: number
  error?: string
}

export interface PreviewProfile {
  font: 'serif' | 'sans' | 'song'
  fontSize: number
  lineHeight: number
  margin: number
  paper: 'warm' | 'white'
}

export interface Settings {
  kindleMode?: 'native' | 'koreader'
  deviceModel?: string
  nativeDelivery?: 'kindle-email' | 'native-cloud'
  onboardingComplete?: boolean
  autoCloudSync?: boolean
  localProfileEnabled?: boolean
  sleepCoverEnabled?: boolean
  readerEngine?: 'koreader' | 'browser'
  readerPageTurn?: 'paper' | 'soft' | 'none'
  sourceUrl: string
  calibreDirectory: string
  cloudFolder: string
  profile: PreviewProfile
  defaultCloudId?: string
  displayName?: string
  avatar?: string
  avatarImage?: string
  avatarTone?: 'sand' | 'clay' | 'moss' | 'slate' | 'plum'
  bio?: string
  location?: string
  syncFolder?: string
}

export interface ReadingSession {
  id: string
  deviceId: string
  source: 'desktop' | 'koreader'
  bookId?: string
  bookHash?: string
  bookTitle: string
  startedAt: string
  endedAt: string
  seconds: number
}
export interface ReadingStats {
  todaySeconds: number
  totalSeconds: number
  days: { date: string; seconds: number; books: string[] }[]
  books: { title: string; seconds: number }[]
}
export interface SyncDevice {
  profileRoute?: 'lan' | 'cloud'
  profileRevision?: string
  profileAvatarHash?: string
  profileReceivedAt?: string
  profileVersion?: number
  bookFormatsVersion?: number
  id: string
  name: string
  accountId: string
  pairedAt: string
  lastSeen?: string
  status: 'awaiting_pairing' | 'connected' | 'revoked'
  error?: string
}
export interface SyncState {
  preferences?: { state: 'pending' | 'uploading' | 'uploaded' | 'error'; error?: string; updatedAt?: string; revision?: string }
  working: boolean
  progress?: { phase: string; done: number; total: number; bytes?: number; totalBytes?: number }
  pairing?: boolean
  lastSuccess?: string
  error?: string
  devices: SyncDevice[]
}

export interface CompanionInspection {
  readerInstalled: boolean
  readerVersion?: string
  pairedDeviceId?: string
  hasCredential: boolean
  revision?: string
}

export interface CompanionSetupState {
  stage: 'idle' | 'checking' | 'authorizing' | 'preparing' | 'installing' | 'awaiting_device' | 'ready' | 'error'
  message: string
  files?: number
  total?: number
  usbDeviceId?: string
  accountId?: string
  pairedDeviceId?: string
  installationId?: string
  revision?: string
  inspection?: CompanionInspection
  installedAt?: string
  verifiedAt?: string
  error?: string
}
export interface DiscoveryResult {
  id: string
  title: string
  author: string
  source: 'local' | 'cloud' | 'zlib' | 'douban'
  doubanUrl?: string
  rating?: number
  edition?: string
  bookId?: string
  cloudId?: string
  remotePath?: string
  sourceBook?: SourceBook
  format?: string
  cover?: string
  size?: number
}
export type DiscoveryScope = 'catalog' | 'files' | 'source' | 'cloud'
export interface KoreaderAction {
  action: 'next' | 'prev' | 'page' | 'tap' | 'refresh' | 'locate' | 'sleep-cover'
  sleepProfile?: { displayName: string; avatar: string; avatarHash?: string; avatarPath?: string }
  sleepStats?: { duration: number; streak: number }
  anchor?: NoteAnchor
  page?: number
  x?: number
  y?: number
}
export interface KoreaderFrame {
  anchorResult?: { found: boolean; accuracy: 'exact' | 'page' | 'ambiguous' | 'missing'; message?: string; start?: string; end?: string; page?: number }
  domVersion?: number
  sessionId: string
  image: Uint8Array
  page: number
  pages: number
  location: string
  font?: string
  fontSize?: number
  version: string
  syncedAt?: string
  exactBook: boolean
  toc: { label: string; page: number }[]
}

export interface AppState {
  initialImport?: {
    status: 'waiting_device' | 'reading' | 'complete' | 'failed'
    model: string
    books: number
    notebooks: number
    annotations: number
    unreadable?: number
    message: string
    error?: string
  }
  kindleMail?: KindleMailState
  libraryCloudSync?: LibraryCloudSync
  discoveryFiles?: { id: string; candidateId: string; sha256: string }[]
  localProfiles?: LocalProfileState
  candidates: Candidate[]
  jobs: TransferJob[]
  downloads: DownloadTask[]
  devices: DeviceInfo[]
  clouds: CloudAccount[]
  settings: Settings
  tools: { calibre: boolean; zlib: boolean; rclone: boolean }
  sourceConnected: boolean
  sourceAccount: SourceAccount
  sourceHealth: SourceHealth
  notebooks: Notebook[]
  notebookTitles?: { total: number; matched: number; catalogs?: number; records?: number; error?: string; updatedAt?: string }
  readingNotes: ReadingNote[]
  notesImport?: NotesImport
  cloudConnecting?: string
  deviceImport?: {
    stage: string
    files: number
    imported: number
    archived: number
    finished?: boolean
    failed?: boolean
  }
  opds?: { address: string; username: string; password: string }
  stats: ReadingStats
  sync: SyncState
  recovery?: { working: boolean; books: number; message?: string; error?: string }
}

export interface LocalProfileState {
  enabled: boolean
  addresses: string[]
  error?: string
}

export interface Approval {
  candidateId: string
  sha256: string
  method: TransferMethod
  deviceId?: string
  cloudAccountId?: string
}

export interface DoubanPageState {
  loading: boolean
  readingMode: boolean
  adapted: boolean
  title?: string
  url?: string
  error?: string
}

export interface DesktopApi {
  prepareKoreader: () => Promise<void>
  saveKindleMail: (input: KindleMailInput) => Promise<void>
  verifyKindleMail: () => Promise<void>
  sendKindleTest: () => Promise<void>
  clearKindleMail: () => Promise<void>
  openKindleHelp: (page: 'email' | 'approved' | 'web' | 'connections') => Promise<void>
  previewSleepCover: (id: string) => Promise<Uint8Array>
  openKoreader: (id: string, force?: boolean) => Promise<KoreaderFrame>
  commandKoreader: (sessionId: string, action: KoreaderAction) => Promise<KoreaderFrame>
  closeKoreader: (sessionId: string) => Promise<void>
  state: () => Promise<AppState>
  subscribe: (listener: (state: AppState) => void) => () => void
  importFiles: () => Promise<string[]>
  importDropped: (files: File[]) => Promise<string[]>
  download: (url: string) => Promise<void>
  preview: (id: string) => Promise<Uint8Array>
  exportBook: (id: string) => Promise<boolean>
  saveReading: (id: string, location: string, progress: number) => Promise<void>
  collect: (id: string) => Promise<void>
  discard: (id: string) => Promise<void>
  approve: (approval: Approval) => Promise<string>
  syncLibraryToCloud: (accountId: string) => Promise<string>
  refreshBookReceipts: () => Promise<void>
  retry: (id: string) => Promise<void>
  cancel: (id: string) => Promise<void>
  refreshDevices: () => Promise<void>
  importDevice: () => Promise<void>
  saveSettings: (settings: Partial<Settings>) => Promise<void>
  publishPreferences: () => Promise<void>
  setLocalProfiles: (enabled: boolean) => Promise<void>
  exportLocalProfilePairing: (id: string) => Promise<void>
  chooseCalibre: () => Promise<void>
  openSource: (mode?: 'auto' | 'custom') => Promise<void>
  checkSources: () => Promise<void>
  checkSourceSession: () => Promise<void>
  importNotes: () => Promise<void>
  refreshNotebookTitles: () => Promise<void>
  importNotebookFiles: () => Promise<void>
  previewNotebook: (id: string) => Promise<Uint8Array>
  saveNotebookReading: (id: string, location: string) => Promise<void>
  exportNotebook: (id: string) => Promise<void>
  exportNotes: (format: 'markdown' | 'json') => Promise<void>
  searchSource: (query: string) => Promise<SourceBook[]>
  downloadSource: (id: string, hash?: string) => Promise<string>
  connectCloud: (provider: 'drive' | 'onedrive') => Promise<void>
  listCloud: (accountId: string, path: string) => Promise<CloudEntry[]>
  downloadCloud: (accountId: string, path: string) => Promise<string>
  enableOpds: () => Promise<void>
  disableOpds: () => Promise<void>
  openDataFolder: () => Promise<void>
  recoverLibrary: () => Promise<void>
  updateBook: (
    id: string,
    fields: { collection?: string; finished?: boolean; title?: string; author?: string },
  ) => Promise<void>
  updateNotebook: (id: string, title: string) => Promise<void>
  linkNote: (id: string, bookId: string) => Promise<void>
  editNote: (id: string, note: string, deleted: boolean) => Promise<void>
  restoreNote: (id: string) => Promise<void>
  recordReading: (session: ReadingSession) => Promise<void>
  searchDiscovery: (query: string, scope?: DiscoveryScope) => Promise<{ results: DiscoveryResult[]; warnings: string[] }>
  openDouban: (query?: string, subject?: string) => Promise<void>
  subscribeDouban: (listener: (state: DoubanPageState) => void) => () => void
  setDoubanReading: (enabled: boolean) => Promise<void>
  openDoubanExternal: () => Promise<void>
  closeDouban: () => Promise<void>
  positionDouban: (bounds: { x: number; y: number; width: number; height: number }) => Promise<void>
  cloudMutate: (id: string, mutation: CloudMutation) => Promise<void>
  cloudReadText: (id: string, path: string) => Promise<{ text: string; hash: string }>
  cloudUpload: (id: string, folder: string) => Promise<void>
  cloudSaveFile: (id: string, path: string) => Promise<void>
  checkCloud: (id: string) => Promise<void>
  syncCloud: (id: string) => Promise<void>
  pairDevice: (id: string, name: string) => Promise<void>
  companionSetup: () => Promise<CompanionSetupState>
  inspectCompanion: (deviceId: string) => Promise<CompanionSetupState>
  installCompanion: (deviceId: string, accountId: string, name: string) => Promise<CompanionSetupState>
  verifyCompanion: () => Promise<CompanionSetupState>
  openCompanionHelp: (page?: 'installation' | 'release' | 'wsl') => Promise<void>
  revokeDevice: (id: string) => Promise<void>
}

export interface KindleMailInput {
  recipient: string
  sender: string
  host: string
  port: number
  security: 'tls' | 'starttls'
  password?: string
  approvedSender: boolean
}

export interface KindleMailState extends Omit<KindleMailInput, 'password'> {
  revision: string
  hasPassword: boolean
  verifiedAt?: string
  configured: boolean
  testSubmittedAt?: string
}

declare global {
  interface Window {
    kindlespouse: DesktopApi
  }
}
