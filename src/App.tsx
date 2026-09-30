/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState, useRef, FormEvent, ChangeEvent } from 'react';
import { Calendar, Shield, Activity, ChevronDown, Check, Download, Menu, X, ExternalLink, FileSpreadsheet, Radio, Zap, RefreshCw, CheckCircle2, Search, Lock, Unlock, Edit3, Save, AlertTriangle, Key } from 'lucide-react';
import { initAuth, googleSignIn, logout, db, getGoogleOAuthToken, setGoogleOAuthToken } from './lib/firebase';
import { createTournamentSpreadsheet, appendPlayerToSpreadsheet, syncAllPlayersToSpreadsheet } from './lib/sheets';
import { User } from 'firebase/auth';
import { collection, query, orderBy, getDocs, doc, getDoc, setDoc, addDoc, serverTimestamp, where, onSnapshot } from 'firebase/firestore';

export const ADMIN_EMAILS = [
  'reyvbg@gmail.com',
  'sspltournament@gmail.com'
];

export const isTournamentAdmin = (email?: string | null): boolean => {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.trim().toLowerCase());
};

export default function App() {
  const [user, setUser] = useState<User | any | null>(null);
  const isAdmin = isTournamentAdmin(user?.email);
  const [needsAuth, setNeedsAuth] = useState(true);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<{ title: string; message: string; code?: string; domain?: string } | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [showUsernamePrompt, setShowUsernamePrompt] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [usernameError, setUsernameError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [registrationSuccess, setRegistrationSuccess] = useState(false);

  // Tournament Status & Registration controls
  const [isRegistrationOpen, setIsRegistrationOpen] = useState(true);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  const [closedNoticeMessage, setClosedNoticeMessage] = useState(
    'Player registrations for SSPL Season 3 are currently closed as the player pool is finalized. Thank you for your interest!'
  );
  const [isEditingMessage, setIsEditingMessage] = useState(false);
  const [customMessageDraft, setCustomMessageDraft] = useState('');
  const [adminPreviewForm, setAdminPreviewForm] = useState(false);

  // Google Sheets & Real-Time state
  const [spreadsheetId, setSpreadsheetId] = useState<string | null>(null);
  const [spreadsheetUrl, setSpreadsheetUrl] = useState<string | null>(null);
  const [isSyncingSheets, setIsSyncingSheets] = useState(false);
  const [sheetsSyncSuccess, setSheetsSyncSuccess] = useState<string | null>(null);
  const [sheetsSyncError, setSheetsSyncError] = useState<string | null>(null);
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);
  const [hasGoogleOAuthToken, setHasGoogleOAuthToken] = useState(false);
  const syncedDocIdsRef = useRef<Set<string>>(new Set());

  // Dashboard state
  const [currentView, setCurrentView] = useState<'home' | 'players'>('home');
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [players, setPlayers] = useState<any[]>([]);
  const [isLoadingPlayers, setIsLoadingPlayers] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('ALL');

  // Form State
  const [formData, setFormData] = useState({
    fullName: '',
    email: '',
    contactNumber: '',
    age: '',
    battingStyle: 'Right Hand',
    battingPosition: 'Top Order',
    bowlingStyle: 'Fast',
    primaryFieldRole: 'Fielder',
    careerDetails: '',
    jerseySize: 'Small',
    jerseyName: '',
    jerseyNumber: ''
  });

  useEffect(() => {
    const unsubscribe = initAuth(
      async (loggedInUser, token) => {
        setUser(loggedInUser);
        setNeedsAuth(false);
        if (loggedInUser.email) {
          setFormData(prev => ({
            ...prev,
            email: prev.email || loggedInUser.email || '',
            fullName: prev.fullName || loggedInUser.displayName || ''
          }));
        }
        if (loggedInUser.phoneNumber) {
          setFormData(prev => ({
            ...prev,
            contactNumber: prev.contactNumber || loggedInUser.phoneNumber || ''
          }));
        }
        await checkProfile(loggedInUser);
      },
      () => {
        setUser(null);
        setNeedsAuth(true);
      }
    );
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (user?.email) {
      setFormData(prev => ({
        ...prev,
        email: prev.email || user.email || '',
        fullName: prev.fullName || user.displayName || ''
      }));
    }
    if (user?.phoneNumber) {
      setFormData(prev => ({
        ...prev,
        contactNumber: prev.contactNumber || user.phoneNumber || ''
      }));
    }
  }, [user]);

  // Real-Time Firestore Registrations Listener + Live Google Sheets Streaming
  useEffect(() => {
    setIsLoadingPlayers(true);
    const q = query(collection(db, 'registrations'), orderBy('createdAt', 'desc'));
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setPlayers(data);
      setIsLoadingPlayers(false);

      // Real-time automatic append to Google Sheets if admin has active OAuth token in memory
      const token = getGoogleOAuthToken();
      if (token) {
        setHasGoogleOAuthToken(true);
      }

      if (isAdmin && token && spreadsheetId) {
        snapshot.docChanges().forEach(change => {
          if (change.type === 'added') {
            const docId = change.doc.id;
            // Only auto-append if not already synced in this session
            if (!syncedDocIdsRef.current.has(docId)) {
              syncedDocIdsRef.current.add(docId);
              const newPlayer = change.doc.data();
              appendPlayerToSpreadsheet(token, spreadsheetId, newPlayer)
                .then(() => {
                  const nowStr = new Date().toLocaleTimeString();
                  setLastSyncTime(nowStr);
                  setSheetsSyncSuccess(`⚡ Real-time sync: Streamed "${newPlayer.fullName || 'New Player'}" directly to Google Sheet at ${nowStr}`);
                })
                .catch(err => {
                  console.warn('Real-time append error:', err);
                });
            }
          }
        });
      }
    }, (error) => {
      console.error("Real-time registrations listener error:", error);
      setIsLoadingPlayers(false);
    });

    return () => unsubscribe();
  }, [user, spreadsheetId]);

  useEffect(() => {
    loadSheetsConfig();

    // Real-time listener for tournament registration status & custom notice
    const unsubStatus = onSnapshot(doc(db, 'settings', 'tournament_status'), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (typeof data.isRegistrationOpen === 'boolean') {
          setIsRegistrationOpen(data.isRegistrationOpen);
        }
        if (data.closedNoticeMessage) {
          setClosedNoticeMessage(data.closedNoticeMessage);
          setCustomMessageDraft(data.closedNoticeMessage);
        }
      }
    }, (err) => {
      console.warn('Tournament status subscription notice:', err);
    });

    return () => unsubStatus();
  }, []);

  const loadSheetsConfig = async () => {
    try {
      const docRef = doc(db, 'settings', 'tournament_sheets');
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (data.spreadsheetId) setSpreadsheetId(data.spreadsheetId);
        if (data.spreadsheetUrl) setSpreadsheetUrl(data.spreadsheetUrl);
      }
    } catch (e) {
      console.warn('Sheets config notice:', e);
    }
  };

  const handleToggleRegistrationStatus = async () => {
    if (!isAdmin) {
      alert('Only the tournament director can change registration status.');
      return;
    }
    setIsUpdatingStatus(true);
    try {
      const nextStatus = !isRegistrationOpen;
      await setDoc(doc(db, 'settings', 'tournament_status'), {
        isRegistrationOpen: nextStatus,
        closedNoticeMessage: closedNoticeMessage,
        updatedAt: serverTimestamp(),
        updatedBy: user?.email
      }, { merge: true });
      setIsRegistrationOpen(nextStatus);
    } catch (err: any) {
      console.error('Error toggling registration status:', err);
      alert('Failed to update registration status: ' + err.message);
    } finally {
      setIsUpdatingStatus(false);
    }
  };

  const handleSaveClosedNoticeMessage = async () => {
    if (!isAdmin) return;
    setIsUpdatingStatus(true);
    try {
      const msg = customMessageDraft.trim() || 'Player registrations for SSPL Season 3 are currently closed as the player pool is finalized. Thank you for your interest!';
      await setDoc(doc(db, 'settings', 'tournament_status'), {
        closedNoticeMessage: msg,
        updatedAt: serverTimestamp(),
        updatedBy: user.email
      }, { merge: true });
      setClosedNoticeMessage(msg);
      setIsEditingMessage(false);
    } catch (err: any) {
      console.error('Error saving message:', err);
      alert('Failed to save message: ' + err.message);
    } finally {
      setIsUpdatingStatus(false);
    }
  };

  const handleSyncGoogleSheets = async () => {
    setIsSyncingSheets(true);
    setSheetsSyncSuccess(null);
    setSheetsSyncError(null);

    try {
      let token = getGoogleOAuthToken();
      if (!token) {
        const res = await googleSignIn(true);
        if (res?.googleOAuthToken) {
          token = res.googleOAuthToken;
          setHasGoogleOAuthToken(true);
        }
      }

      if (!token) {
        throw new Error('Please sign in with Google to grant Google Sheets permission.');
      }
      setHasGoogleOAuthToken(true);

      // 1. Fetch fresh player registrations from Firestore
      let freshPlayers: any[] = [];
      try {
        const q = query(collection(db, 'registrations'), orderBy('createdAt', 'desc'));
        const querySnapshot = await getDocs(q);
        freshPlayers = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        setPlayers(freshPlayers);
      } catch (loadErr: any) {
        console.warn('Could not query registrations, falling back to state:', loadErr);
        freshPlayers = players;
      }

      let activeSheetId = spreadsheetId;
      let activeSheetUrl = spreadsheetUrl;

      // 2. If no spreadsheet exists yet, create a dedicated tournament sheet
      if (!activeSheetId) {
        const created = await createTournamentSpreadsheet(token, 'SSPL S3 - Tournament Players Roster');
        activeSheetId = created.spreadsheetId;
        activeSheetUrl = created.spreadsheetUrl;
        setSpreadsheetId(activeSheetId);
        setSpreadsheetUrl(activeSheetUrl);

        try {
          await setDoc(doc(db, 'settings', 'tournament_sheets'), {
            spreadsheetId: activeSheetId,
            spreadsheetUrl: activeSheetUrl,
            title: 'SSPL S3 - Tournament Players Roster',
            updatedAt: serverTimestamp()
          });
        } catch (saveErr) {
          console.warn('Settings save notice:', saveErr);
        }
      }

      // 3. Mark all current documents as synced
      freshPlayers.forEach(p => {
        if (p.id) syncedDocIdsRef.current.add(p.id);
      });

      // 4. Sync all player records to the Google Sheet
      await syncAllPlayersToSpreadsheet(token, activeSheetId, freshPlayers);

      const nowStr = new Date().toLocaleTimeString();
      setLastSyncTime(nowStr);

      if (freshPlayers.length > 0) {
        setSheetsSyncSuccess(`⚡ Real-Time Sync Success! Synced all ${freshPlayers.length} registered player${freshPlayers.length === 1 ? '' : 's'} to Google Sheets at ${nowStr}. Live streaming is active.`);
      } else {
        setSheetsSyncSuccess('Google Sheet connected & formatted with headers! Live real-time sync is active. New player registrations will automatically stream to the sheet.');
      }
    } catch (err: any) {
      console.error('Google Sheets sync error:', err);
      setSheetsSyncError(err.message || 'Failed to sync with Google Sheets');
    } finally {
      setIsSyncingSheets(false);
    }
  };

  const loadPlayers = async () => {
    setIsLoadingPlayers(true);
    try {
      const q = query(collection(db, 'registrations'), orderBy('createdAt', 'desc'));
      const querySnapshot = await getDocs(q);
      const data = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setPlayers(data);
    } catch (err) {
      console.error("Error loading players:", err);
    } finally {
      setIsLoadingPlayers(false);
    }
  };

  const exportToCSV = () => {
    if (!isAdmin) {
      alert('You do not have permission to export data.');
      return;
    }
    if (players.length === 0) return;
    
    const headers = [
      'Full Name', 'Email', 'Contact Number', 'Age', 'Batting Style', 'Batting Position', 
      'Bowling Style', 'Primary Field Role', 'Career Details', 'Jersey Size', 
      'Jersey Name', 'Jersey Number'
    ];
    
    const csvContent = [
      headers.join(','),
      ...players.map(p => {
        return [
          `"${p.fullName || ''}"`,
          `"${p.email || p.userEmail || ''}"`,
          `"${p.contactNumber || ''}"`,
          `"${p.age || ''}"`,
          `"${p.battingStyle || ''}"`,
          `"${p.battingPosition || ''}"`,
          `"${p.bowlingStyle || ''}"`,
          `"${p.primaryFieldRole || ''}"`,
          `"${(p.careerDetails || '').replace(/"/g, '""')}"`,
          `"${p.jerseySize || ''}"`,
          `"${p.jerseyName || ''}"`,
          `"${p.jerseyNumber || ''}"`
        ].join(',');
      })
    ].join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tournament-players-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const checkProfile = async (loggedInUser: User) => {
    try {
      const docRef = doc(db, 'profiles', loggedInUser.uid);
      const docSnap = await getDoc(docRef);
      
      if (docSnap.exists() && docSnap.data().username) {
        setUsername(docSnap.data().username);
      } else {
        setShowUsernamePrompt(true);
      }
    } catch (err) {
      console.warn('Profile check error:', err);
      setUsername(loggedInUser.displayName || loggedInUser.email?.split('@')[0] || loggedInUser.phoneNumber || 'Player');
    }
  };

  const handleLogin = async () => {
    setIsLoggingIn(true);
    setLoginError(null);
    try {
      const result = await googleSignIn(false);
      if (result) {
        setUser(result.user);
        setNeedsAuth(false);
        if (result.user.email) {
          setFormData(prev => ({
            ...prev,
            email: result.user.email || prev.email,
            fullName: result.user.displayName || prev.fullName
          }));
        }
        await checkProfile(result.user);
      }
    } catch (err: any) {
      console.error('Login failed:', err);
      const currentHost = typeof window !== 'undefined' ? window.location.hostname : '';
      if (err.code === 'auth/unauthorized-domain') {
        setLoginError({
          title: 'Domain Not Authorized in Firebase',
          message: `The domain "${currentHost}" is not on your Firebase Authorized Domains list. Google blocks login popups until this domain is added in Firebase Console. (You can still fill and submit the form directly below without logging in!)`,
          code: err.code,
          domain: currentHost
        });
      } else if (err.code === 'auth/popup-blocked') {
        setLoginError({
          title: 'Browser Blocked Login Popup',
          message: 'Your browser prevented the Google login popup from opening. Please allow popups in your address bar, or simply fill in the form fields directly.',
          code: err.code
        });
      } else if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') {
        setLoginError({
          title: 'Login Popup Closed',
          message: 'The Google Sign-In window was closed. You can try again or fill in the form fields directly without signing in.',
          code: err.code
        });
      } else {
        setLoginError({
          title: 'Google Sign In Notice',
          message: err.message || 'Unable to sign in with Google. You can register directly without logging in.',
          code: err.code
        });
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleSaveUsername = async () => {
    if (!newUsername.trim()) {
      setUsernameError('Username is required');
      return;
    }
    
    if (!user) return;
    setIsSubmitting(true);
    setUsernameError('');
    
    try {
      const q = query(collection(db, 'profiles'), where('username', '==', newUsername.trim()));
      const querySnapshot = await getDocs(q);
        
      if (!querySnapshot.empty) {
        setUsernameError('Username is already taken');
        setIsSubmitting(false);
        return;
      }

      await setDoc(doc(db, 'profiles', user.uid), {
        userId: user.uid,
        username: newUsername.trim(),
        email: user.email
      });
      
      setUsername(newUsername.trim());
      setShowUsernamePrompt(false);
    } catch (err: any) {
      console.warn('Failed to save username, proceeding with local state', err);
      setUsername(newUsername.trim());
      setShowUsernamePrompt(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleInputChange = (e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (!isRegistrationOpen && !isAdmin) {
      alert("Player registrations for SSPL Season 3 are currently closed.");
      return;
    }

    if (!formData.fullName.trim() || !formData.email.trim() || !formData.contactNumber.trim()) {
      alert("Please fill in all required fields (Full Name, Email, Contact Number).");
      return;
    }

    if (formData.age) {
      const ageNum = parseInt(formData.age, 10);
      if (isNaN(ageNum) || ageNum < 11 || ageNum > 80) {
        alert("Age must be at least 11 and up to 80 years old.");
        return;
      }
    }

    setIsSubmitting(true);
    setRegistrationSuccess(false);

    try {
      const docRef = await addDoc(collection(db, 'registrations'), {
        userId: user ? user.uid : 'guest',
        userEmail: formData.email.trim(),
        email: formData.email.trim(),
        fullName: formData.fullName.trim(),
        contactNumber: formData.contactNumber.trim(),
        age: formData.age,
        battingStyle: formData.battingStyle,
        battingPosition: formData.battingPosition,
        bowlingStyle: formData.bowlingStyle,
        primaryFieldRole: formData.primaryFieldRole,
        careerDetails: formData.careerDetails,
        jerseySize: formData.jerseySize,
        jerseyName: formData.jerseyName,
        jerseyNumber: formData.jerseyNumber,
        createdAt: serverTimestamp()
      });

      syncedDocIdsRef.current.add(docRef.id);
      setRegistrationSuccess(true);
      
      // Auto-append to connected Google Sheet if spreadsheetId exists and user has active OAuth token
      const oauthToken = getGoogleOAuthToken();
      if (spreadsheetId && oauthToken) {
        appendPlayerToSpreadsheet(oauthToken, spreadsheetId, {
          fullName: formData.fullName.trim(),
          email: formData.email.trim(),
          contactNumber: formData.contactNumber.trim(),
          age: formData.age,
          battingStyle: formData.battingStyle,
          battingPosition: formData.battingPosition,
          bowlingStyle: formData.bowlingStyle,
          primaryFieldRole: formData.primaryFieldRole,
          careerDetails: formData.careerDetails,
          jerseySize: formData.jerseySize,
          jerseyName: formData.jerseyName,
          jerseyNumber: formData.jerseyNumber,
          createdAt: new Date()
        }).then(() => {
          const time = new Date().toLocaleTimeString();
          setLastSyncTime(time);
        }).catch(sheetErr => {
          console.warn('Auto-append to Google Sheet warning:', sheetErr);
        });
      }
      
      // Reset form (keeping logged-in user's name/email if applicable)
      setFormData({
        fullName: user?.displayName || '',
        email: user?.email || '',
        contactNumber: '',
        age: '',
        battingStyle: 'Right Hand',
        battingPosition: 'Top Order',
        bowlingStyle: 'Fast',
        primaryFieldRole: 'Fielder',
        careerDetails: '',
        jerseySize: 'Small',
        jerseyName: '',
        jerseyNumber: ''
      });
      
      setTimeout(() => setRegistrationSuccess(false), 6000);
    } catch (err: any) {
      alert('Error submitting registration: ' + err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const getPlayerCricketRole = (player: any): 'Wicketkeeper' | 'Batsman' | 'Bowler' | 'All-Rounder' => {
    const fieldRole = (player.primaryFieldRole || '').toLowerCase();
    const bowling = (player.bowlingStyle || '').toLowerCase();
    const battingPos = (player.battingPosition || '').toLowerCase();

    if (fieldRole.includes('wicket') || fieldRole.includes('keeper')) {
      return 'Wicketkeeper';
    }
    if (bowling.includes('not a bowler') || !bowling || bowling === 'none') {
      return 'Batsman';
    }
    if (battingPos.includes('top order') || battingPos.includes('middle order')) {
      return 'All-Rounder';
    }
    return 'Bowler';
  };

  const filteredPlayers = players.filter((player) => {
    // 1. Role Filter matching
    const roleKey = roleFilter.toUpperCase().replace(/[\s-_]/g, '');
    if (roleKey !== 'ALL') {
      const computedRole = getPlayerCricketRole(player).toUpperCase().replace(/[\s-_]/g, '');
      const bowling = (player.bowlingStyle || '').toLowerCase();
      const fieldRole = (player.primaryFieldRole || '').toLowerCase();

      let matches = false;
      if (roleKey === 'BATSMAN' || roleKey === 'BATSMEN') {
        matches = computedRole === 'BATSMAN' || bowling.includes('not a bowler');
      } else if (roleKey === 'BOWLER' || roleKey === 'BOWLERS') {
        matches = computedRole === 'BOWLER' || (!bowling.includes('not a bowler') && bowling.length > 0);
      } else if (roleKey === 'ALLROUNDER' || roleKey === 'ALLROUNDERS') {
        matches = computedRole === 'ALLROUNDER';
      } else if (roleKey === 'WICKETKEEPER' || roleKey === 'WICKETKEEPERS' || roleKey === 'KEEPER') {
        matches = fieldRole.includes('keeper') || computedRole === 'WICKETKEEPER';
      } else {
        matches = computedRole === roleKey;
      }
      if (!matches) return false;
    }

    // 2. Search query matching
    const trimmed = searchQuery.trim();
    if (!trimmed) return true;

    // Tokenize query into distinct search terms (e.g. "rohit 7 fast" -> ["rohit", "7", "fast"])
    const terms = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return true;

    const fullName = (player.fullName || '').toLowerCase();
    const jerseyName = (player.jerseyName || '').toLowerCase();
    const jerseyNum = String(player.jerseyNumber ?? '').trim();
    const computedRole = getPlayerCricketRole(player).toLowerCase();
    const fieldRole = (player.primaryFieldRole || '').toLowerCase();
    const battingStyle = (player.battingStyle || '').toLowerCase();
    const battingPos = (player.battingPosition || '').toLowerCase();
    const bowlingStyle = (player.bowlingStyle || '').toLowerCase();
    const age = String(player.age ?? '').trim();
    const career = (player.careerDetails || '').toLowerCase();

    // ALL terms must match for a player to be included (AND logic)
    return terms.every((term) => {
      // 2a. Numerical matching: jersey number or exact age
      const isHashPrefixed = term.startsWith('#');
      const cleanNum = isHashPrefixed ? term.slice(1) : term;
      const isPureNumber = /^\d+$/.test(cleanNum);

      if (isPureNumber) {
        if (jerseyNum === cleanNum) return true;
        if (!isHashPrefixed && age === cleanNum) return true;
        if (isHashPrefixed) return false;
      }

      // 2b. Name and Jersey Name matching
      if (fullName.includes(term) || jerseyName.includes(term)) return true;

      // 2c. Cricket Role & Style synonyms
      if (term === 'batsman' || term === 'batter' || term === 'batting' || term === 'bat') {
        return computedRole === 'batsman' || computedRole === 'all-rounder' || bowlingStyle === 'not a bowler';
      }
      if (term === 'bowler' || term === 'bowling' || term === 'bowl') {
        return computedRole === 'bowler' || computedRole === 'all-rounder' || (bowlingStyle !== 'not a bowler' && bowlingStyle.length > 0);
      }
      if (term === 'allrounder' || term === 'all-rounder' || term === 'all' || term === 'rounder') {
        return computedRole === 'all-rounder';
      }
      if (term === 'keeper' || term === 'wicketkeeper' || term === 'wk' || term === 'wicket') {
        return fieldRole.includes('keeper') || computedRole === 'wicketkeeper';
      }
      if (term === 'fast' || term === 'pacer' || term === 'pace') {
        return bowlingStyle.includes('fast');
      }
      if (term === 'spin' || term === 'spinner') {
        return bowlingStyle.includes('spin');
      }
      if (term === 'medium' || term === 'seamer' || term === 'seam') {
        return bowlingStyle.includes('medium');
      }
      if (term === 'left' || term === 'lefty' || term === 'lhb') {
        return battingStyle.includes('left');
      }
      if (term === 'right' || term === 'rhb') {
        return battingStyle.includes('right');
      }
      if (term === 'opener' || term === 'top') {
        return battingPos.includes('top order');
      }
      if (term === 'middle') {
        return battingPos.includes('middle order');
      }
      if (term === 'finisher') {
        return battingPos.includes('finisher');
      }

      // 2d. Exact field matches
      if (battingStyle.includes(term) || battingPos.includes(term) || bowlingStyle.includes(term) || fieldRole.includes(term)) {
        return true;
      }

      // 2e. Text search in career details / email (only for 3+ letters to avoid random single-letter false matches)
      if (term.length >= 3) {
        if (career.includes(term)) return true;
        if (player.email?.toLowerCase().includes(term)) return true;
      }

      return false;
    });
  });

  return (
    <div className="bg-[#f9f9f9] text-[#1b1b1b] min-h-screen overflow-x-hidden font-sans selection:bg-[#410001] selection:text-white">
      {/* Auth / Username Overlay */}
      {showUsernamePrompt && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white p-8 border-2 border-black max-w-md w-full shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]">
            <h2 className="font-[Anton] text-3xl uppercase mb-2">Claim Your Legacy</h2>
            <p className="text-gray-600 mb-6 font-medium">Choose a unique username to complete your profile.</p>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-bold uppercase tracking-wider mb-2">Username</label>
                <input 
                  type="text" 
                  value={newUsername}
                  onChange={e => setNewUsername(e.target.value)}
                  className="w-full border-2 border-gray-300 p-3 font-medium focus:outline-none focus:border-red-600 focus:ring-2 focus:ring-red-600/20 transition-all"
                  placeholder="e.g. Maverick"
                />
                {usernameError && <p className="text-red-600 text-sm mt-2 font-bold">{usernameError}</p>}
              </div>
              <div className="flex gap-4">
                <button 
                  onClick={() => {
                    setShowUsernamePrompt(false);
                    setUsername(user?.displayName || user?.email?.split('@')[0] || user?.phoneNumber || 'Player');
                  }}
                  disabled={isSubmitting}
                  className="w-1/3 bg-gray-200 text-black py-4 font-[Anton] text-xl uppercase tracking-wider shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-gray-300 transition-all active:translate-y-1 active:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] disabled:opacity-70"
                >
                  Skip
                </button>
                <button 
                  onClick={handleSaveUsername}
                  disabled={isSubmitting}
                  className="w-2/3 bg-[#410001] text-white py-4 font-[Anton] text-xl uppercase tracking-wider shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-black transition-all active:translate-y-1 active:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] disabled:opacity-70"
                >
                  {isSubmitting ? 'Verifying...' : 'Set Username'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="w-full sticky top-0 z-50 bg-[#f9f9f9] border-b-2 border-black">
        <nav className="flex justify-between items-center px-4 md:px-12 py-4 max-w-7xl mx-auto">
          <div className="font-[Anton] text-3xl text-black uppercase tracking-tighter cursor-pointer" onClick={() => setCurrentView('home')}>
            SSPL S3
          </div>
          <div className="hidden md:flex items-center gap-6">
            <a href="#" onClick={(e) => { e.preventDefault(); setCurrentView('home'); }} className={`font-semibold text-sm tracking-wider uppercase ${currentView === 'home' ? 'text-black' : 'text-gray-600 hover:text-black'}`}>Home</a>
            <a href="#" onClick={(e) => { e.preventDefault(); setCurrentView('players'); }} className={`font-semibold text-sm tracking-wider uppercase ${currentView === 'players' ? 'text-black' : 'text-gray-600 hover:text-black'}`}>Draft Board</a>
            <a href="#schedules" onClick={() => { if (currentView !== 'home') setCurrentView('home'); }} className="font-semibold text-sm tracking-wider text-gray-600 hover:text-black uppercase">Schedules</a>
          </div>
          <div className="hidden md:flex items-center gap-4">
            {user ? (
              <div className="flex items-center gap-4">
                <span className={`font-bold text-sm px-3 py-1 rounded-full ${isAdmin ? 'bg-[#410001] text-white shadow-sm' : 'bg-gray-200'}`}>
                  {isAdmin ? `🛡️ ${username || user.displayName || user.email}` : (username || user.displayName || user.email)}
                </span>
                <button 
                  onClick={logout}
                  className="border-2 border-black px-4 py-2 font-bold text-sm uppercase hover:bg-gray-100 transition-colors"
                >
                  Sign Out
                </button>
              </div>
            ) : (
              <button 
                onClick={handleLogin}
                disabled={isLoggingIn}
                className="gsi-material-button flex items-center justify-center gap-2 bg-white border border-gray-300 px-4 py-2 hover:bg-gray-50 transition-colors shadow-sm text-sm font-semibold"
              >
                <svg width="18" height="18" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"></path>
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"></path>
                  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"></path>
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"></path>
                  <path fill="none" d="M0 0h48v48H0z"></path>
                </svg>
                <span className="font-medium text-gray-700">{isLoggingIn ? 'Connecting...' : 'Sign in with Google'}</span>
              </button>
            )}
          </div>
          <button 
            className="md:hidden p-2 flex items-center justify-center text-black"
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          >
            {isMobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </nav>
        {isMobileMenuOpen && (
          <div className="md:hidden flex flex-col border-t-2 border-black bg-white px-4 py-4 gap-4">
            <a href="#" onClick={(e) => { e.preventDefault(); setCurrentView('home'); setIsMobileMenuOpen(false); }} className={`font-semibold text-lg tracking-wider uppercase ${currentView === 'home' ? 'text-black' : 'text-gray-600'}`}>Home</a>
            <a href="#" onClick={(e) => { e.preventDefault(); setCurrentView('players'); setIsMobileMenuOpen(false); }} className={`font-semibold text-lg tracking-wider uppercase ${currentView === 'players' ? 'text-black' : 'text-gray-600'}`}>Draft Board</a>
            <a href="#schedules" onClick={() => { if (currentView !== 'home') setCurrentView('home'); setIsMobileMenuOpen(false); }} className="font-semibold text-lg tracking-wider text-gray-600 uppercase">Schedules</a>
            
            <div className="h-px bg-gray-200 my-2"></div>
            
            {user ? (
              <div className="flex flex-col gap-4">
                <span className={`font-bold text-sm px-3 py-2 rounded-full text-center ${isAdmin ? 'bg-[#410001] text-white' : 'bg-gray-200'}`}>
                  {isAdmin ? `🛡️ ${username || user.displayName || user.email}` : (username || user.displayName || user.email)}
                </span>
                <button 
                  onClick={() => { logout(); setIsMobileMenuOpen(false); }}
                  className="border-2 border-black px-4 py-3 font-bold text-sm uppercase bg-[#410001] text-white hover:bg-black transition-colors"
                >
                  Sign Out
                </button>
              </div>
            ) : (
              <button 
                onClick={() => { handleLogin(); setIsMobileMenuOpen(false); }}
                disabled={isLoggingIn}
                className="gsi-material-button flex items-center justify-center gap-3 bg-white border border-gray-300 px-4 py-3 hover:bg-gray-50 transition-colors shadow-sm"
              >
                <svg width="20" height="20" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"></path>
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"></path>
                  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"></path>
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"></path>
                  <path fill="none" d="M0 0h48v48H0z"></path>
                </svg>
                <span className="font-medium text-gray-700 text-sm">Sign in with Google</span>
              </button>
            )}
          </div>
        )}
      </header>

      {/* Login Error / Domain Authorization Banner */}
      {loginError && (
        <div className="bg-red-50 border-b-2 border-red-500 px-4 py-3 text-red-900 sticky top-[73px] z-40 shadow-md">
          <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
              <div>
                <div className="font-bold text-sm text-red-900 flex items-center gap-2">
                  <span>{loginError.title}</span>
                  {loginError.code && <span className="text-xs bg-red-200 text-red-800 px-2 py-0.5 rounded font-mono">{loginError.code}</span>}
                </div>
                <p className="text-xs text-red-800 mt-0.5">{loginError.message}</p>
                {loginError.domain && (
                  <div className="mt-2 text-xs bg-white p-2.5 border border-red-300 rounded font-mono text-gray-900 space-y-1">
                    <div><strong>Domain to Authorize:</strong> <span className="bg-yellow-100 px-1.5 py-0.5 font-bold text-black">{loginError.domain}</span></div>
                    <div className="text-gray-600 font-sans">
                      Go to <a href="https://console.firebase.google.com" target="_blank" rel="noopener noreferrer" className="underline font-bold text-blue-700">Firebase Console</a> ➔ Authentication ➔ Settings ➔ Authorized Domains ➔ Click "Add domain".
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0 self-end md:self-center">
              <button
                onClick={() => setLoginError(null)}
                className="text-gray-500 hover:text-black p-1.5"
                title="Dismiss"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content */}
      {currentView === 'home' ? (
        <>
          {/* Hero Section */}
          <section className="relative h-[600px] md:h-[870px] flex items-center justify-center overflow-hidden bg-black">
            <div className="absolute inset-0 z-0 overflow-hidden">
              <div 
                className="w-full h-full scale-105 filter brightness-50 contrast-125" 
                style={{ 
                  backgroundImage: 'url("https://lh3.googleusercontent.com/aida-public/AB6AXuD2reYbW-dTO9EOTZc7nIxlZA8iQ0etzQxnPRIjLTM_1h6JT8Yenza5SpMCSZj8WjRUO3aVUWC2JNdfciHz_E5HMRaxxzRangsTqqgmsQBFXoJJtsrDfMhfpH1kNHVBspXhRexKzBQwSvIr6W0EZAImQx9xB7qHCkDBLIDWI58m087z1t838Z_h2k2iVoRZJo2HPP1iVpTKM3468dfLlhXTR999ixTtQ-UNnr7R_A2YBiKncIHMp3jgLTNS4XtxVr2qjtsCFvijGNIH")',
                  backgroundSize: 'cover', 
                  backgroundPosition: 'center center' 
                }}
              ></div>
            </div>
        
        <div className="relative z-10 text-center px-4 md:px-12 max-w-4xl mx-auto mt-16 md:mt-0">
          <h1 className="font-[Anton] text-[56px] md:text-[96px] text-white uppercase leading-[1] tracking-tighter mb-8">
            STEP UP TO <br/><span className="text-[#ffb4a9]">THE PLATE</span>
          </h1>
          <div className="flex flex-col md:flex-row gap-6 justify-center items-center">
            {isRegistrationOpen ? (
              <a href="#registration" className="bg-[#410001] text-white px-10 py-5 font-[Anton] text-2xl uppercase shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] hover:bg-red-900 transition-all active:translate-y-1 active:shadow-[2px_2px_0px_0px_rgba(255,255,255,1)]">
                Join The Fight
              </a>
            ) : (
              <button 
                onClick={() => setCurrentView('players')}
                className="bg-[#410001] text-white px-8 py-5 font-[Anton] text-xl md:text-2xl uppercase shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] hover:bg-black transition-all active:translate-y-1 active:shadow-[2px_2px_0px_0px_rgba(255,255,255,1)] flex items-center justify-center gap-3 border-2 border-white/20"
              >
                <Lock className="w-5 h-5 text-red-300" />
                <span>Registrations Closed • View Draft Board</span>
              </button>
            )}
          </div>
        </div>
        
        <div 
          className="absolute bottom-0 right-0 w-full h-16 bg-[#f9f9f9]" 
          style={{ clipPath: 'polygon(100% 0, 0% 100%, 100% 100%)' }}
        ></div>
      </section>

      {/* Schedules Section */}
      <section id="schedules" className="py-20 px-4 md:px-12 max-w-xl mx-auto">
        <div className="bg-white border-2 border-black p-8 relative overflow-hidden group shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
          <div className="absolute top-0 left-0 w-full h-1 bg-red-700"></div>
          <div className="flex flex-col gap-4">
            <Calendar className="text-red-700 w-10 h-10" />
            <h3 className="font-[Anton] text-3xl uppercase tracking-wide">Schedules</h3>
            <p className="text-gray-900 font-bold text-xl">Will Be Announced Later.</p>
            <div className="mt-4 pt-4 border-t border-gray-200">
              <span className="font-bold text-xs uppercase text-red-700 tracking-wider">Tournament Fixtures & Dates</span>
            </div>
          </div>
        </div>
      </section>

      {/* Player Registration Form */}
      <section id="registration" className="bg-[#e8e8e8] py-32 px-4 md:px-12 border-y-2 border-black">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="font-[Anton] text-5xl md:text-[72px] uppercase text-black mb-4 tracking-tight leading-none">Player Registration</h2>
            <div className="w-24 h-2 bg-red-700 mx-auto mb-6"></div>
            <p className="text-lg text-gray-700 font-medium">Complete the elite scouting profile to enter the draft lottery.</p>
          </div>
          
          {/* Tournament Director Admin Controls */}
          {isAdmin && (
            <div className="mb-8 p-6 bg-white border-4 border-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b-2 border-black pb-4 mb-4">
                <div className="flex items-center gap-3">
                  <span className="bg-black text-white text-xs font-black uppercase px-2.5 py-1 tracking-wider">Director Controls</span>
                  <div className="flex items-center gap-2">
                    <span className={`w-3 h-3 rounded-full ${isRegistrationOpen ? 'bg-emerald-500 animate-pulse' : 'bg-red-600'}`}></span>
                    <span className="font-[Anton] text-xl uppercase tracking-wide">
                      Registration Status: {isRegistrationOpen ? (
                        <span className="text-emerald-700">OPEN</span>
                      ) : (
                        <span className="text-red-700">CLOSED</span>
                      )}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                  <button
                    type="button"
                    onClick={handleToggleRegistrationStatus}
                    disabled={isUpdatingStatus}
                    className={`flex-1 sm:flex-none px-4 py-2.5 font-[Anton] text-base uppercase tracking-wider text-white border-2 border-black transition-all shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 flex items-center justify-center gap-2 ${
                      isRegistrationOpen 
                        ? 'bg-red-700 hover:bg-red-800' 
                        : 'bg-emerald-600 hover:bg-emerald-700'
                    } disabled:opacity-60`}
                  >
                    {isUpdatingStatus ? (
                      <Activity className="w-4 h-4 animate-spin" />
                    ) : isRegistrationOpen ? (
                      <Lock className="w-4 h-4" />
                    ) : (
                      <Unlock className="w-4 h-4" />
                    )}
                    <span>{isRegistrationOpen ? 'Close Registrations' : 'Re-Open Registrations'}</span>
                  </button>

                  {!isRegistrationOpen && (
                    <button
                      type="button"
                      onClick={() => setAdminPreviewForm(!adminPreviewForm)}
                      className="px-3 py-2.5 text-xs font-bold uppercase tracking-wider bg-gray-100 hover:bg-gray-200 border-2 border-black text-black transition-colors"
                    >
                      {adminPreviewForm ? 'Hide Form Preview' : 'Preview Form'}
                    </button>
                  )}
                </div>
              </div>

              {/* Closed Notice Message Customization */}
              {!isRegistrationOpen && (
                <div className="mt-3 pt-2">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="text-xs font-bold uppercase text-gray-700 tracking-wider">
                      Public Notice Message (Shown to visitors when closed):
                    </span>
                    {!isEditingMessage && (
                      <button
                        type="button"
                        onClick={() => {
                          setCustomMessageDraft(closedNoticeMessage);
                          setIsEditingMessage(true);
                        }}
                        className="text-xs font-bold uppercase text-blue-700 hover:text-black flex items-center gap-1"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        <span>Edit Message</span>
                      </button>
                    )}
                  </div>

                  {isEditingMessage ? (
                    <div className="flex flex-col gap-2">
                      <textarea
                        value={customMessageDraft}
                        onChange={(e) => setCustomMessageDraft(e.target.value)}
                        rows={2}
                        className="w-full border-2 border-black p-2.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-black"
                        placeholder="Write message to visitors..."
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setIsEditingMessage(false)}
                          className="px-3 py-1 text-xs font-bold uppercase border border-gray-400 bg-white hover:bg-gray-100"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={handleSaveClosedNoticeMessage}
                          disabled={isUpdatingStatus}
                          className="px-4 py-1 text-xs font-bold uppercase bg-black text-white hover:bg-gray-800 flex items-center gap-1.5"
                        >
                          <Save className="w-3.5 h-3.5" />
                          <span>{isUpdatingStatus ? 'Saving...' : 'Save Notice'}</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-gray-600 bg-gray-50 border border-gray-300 p-2.5 rounded font-mono">
                      "{closedNoticeMessage}"
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* When Registrations are Closed */}
          {!isRegistrationOpen && !adminPreviewForm ? (
            <div className="bg-white border-4 border-black p-8 md:p-14 text-center shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-2 bg-red-700"></div>
              
              <div className="w-20 h-20 bg-red-100 border-2 border-black rounded-full flex items-center justify-center mx-auto mb-6 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
                <Lock className="w-10 h-10 text-red-700" />
              </div>
              
              <h3 className="font-[Anton] text-4xl md:text-5xl uppercase tracking-tight text-black mb-3">
                Registrations Are Closed
              </h3>
              
              <div className="w-24 h-1.5 bg-red-700 mx-auto mb-6"></div>
              
              <p className="text-base md:text-xl text-gray-800 max-w-xl mx-auto font-medium mb-8 leading-relaxed">
                {closedNoticeMessage}
              </p>
              
              <div className="inline-flex items-center gap-6 bg-[#f9f9f9] border-2 border-black px-6 py-4 mb-8 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
                <div>
                  <span className="block text-xs font-bold uppercase tracking-wider text-gray-500">Official Roster</span>
                  <span className="font-[Anton] text-3xl text-black">{players.length} Players</span>
                </div>
                <div className="w-px h-10 bg-gray-300"></div>
                <div>
                  <span className="block text-xs font-bold uppercase tracking-wider text-gray-500">Draft Status</span>
                  <span className="font-[Anton] text-xl text-emerald-700 uppercase">Pool Finalized</span>
                </div>
              </div>

              <div>
                <button
                  type="button"
                  onClick={() => setCurrentView('players')}
                  className="bg-[#410001] text-white px-8 py-5 font-[Anton] text-xl md:text-2xl uppercase tracking-wider shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-black transition-all active:translate-y-1 active:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] inline-flex items-center gap-3"
                >
                  <Search className="w-6 h-6" />
                  <span>Scout Players on Draft Board</span>
                </button>
              </div>
            </div>
          ) : (
            <>
              {adminPreviewForm && !isRegistrationOpen && (
                <div className="mb-4 p-3 bg-amber-100 border-2 border-amber-800 text-amber-900 text-xs font-bold uppercase tracking-wider flex items-center justify-between">
                  <span>⚠️ Admin Preview Mode: Registrations are currently CLOSED to visitors. Only you can see this form.</span>
                  <button onClick={() => setAdminPreviewForm(false)} className="underline hover:text-black">Exit Preview</button>
                </div>
              )}
              <form onSubmit={handleSubmit} className="bg-white border-2 border-black p-8 md:p-12 space-y-8 shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] relative">
            {registrationSuccess && (
              <div className="absolute inset-0 z-10 bg-white/95 backdrop-blur flex flex-col items-center justify-center p-8 text-center border-2 border-green-600">
                <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mb-6">
                  <Check className="w-10 h-10 text-green-600" />
                </div>
                <h3 className="font-[Anton] text-4xl uppercase text-green-700 mb-2">Registration Complete</h3>
                <p className="text-lg font-medium text-gray-700">Your profile has been secured in our systems.</p>
              </div>
            )}
            
            <div className="border-b-2 border-gray-200 pb-4 mb-6">
              {user ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-xs uppercase tracking-widest text-gray-600">
                      Signed in as: <strong className="text-black">{username || user.displayName || user.email}</strong>
                    </span>
                    <span className="font-bold text-xs tracking-widest uppercase text-green-800 bg-green-100 px-3 py-1">
                      Profile Auto-filled
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={logout}
                    className="text-xs text-gray-500 hover:text-red-700 underline font-bold uppercase"
                  >
                    Sign Out / Switch Account
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-green-500"></span>
                      <span className="font-bold text-xs uppercase tracking-wider text-gray-700">
                        Open Registration • No login required to register
                      </span>
                    </div>
                    <button 
                      type="button" 
                      onClick={handleLogin}
                      disabled={isLoggingIn}
                      className="text-xs font-bold uppercase tracking-wider text-gray-800 hover:text-black border border-gray-300 px-3 py-1.5 bg-gray-50 hover:bg-gray-100 transition-colors flex items-center gap-1.5 shadow-sm"
                    >
                      <svg width="14" height="14" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
                        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"></path>
                        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"></path>
                        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"></path>
                        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"></path>
                        <path fill="none" d="M0 0h48v48H0z"></path>
                      </svg>
                      <span>{isLoggingIn ? 'Connecting...' : 'Auto-fill with Google'}</span>
                    </button>
                  </div>

                  {loginError && (
                    <div className="bg-amber-50 border-2 border-amber-400 p-3 text-xs text-amber-950 rounded">
                      <div className="font-bold flex items-center justify-between">
                        <span>⚠️ {loginError.title}</span>
                        <button type="button" onClick={() => setLoginError(null)} className="text-gray-500 hover:text-black font-bold">✕</button>
                      </div>
                      <p className="mt-1 text-gray-700">{loginError.message}</p>
                      <p className="mt-2 font-bold text-gray-900 bg-amber-100 p-1.5 rounded">
                        👉 You can register right now by simply typing your details into the form below!
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="flex flex-col gap-2">
                <label className="font-bold text-xs uppercase tracking-wider text-gray-800">Full Name *</label>
                <input 
                  type="text" name="fullName" required
                  value={formData.fullName} onChange={handleInputChange}
                  className="w-full border-2 border-gray-300 p-4 font-medium focus:outline-none focus:border-black focus:ring-4 focus:ring-black/10 transition-all"
                  placeholder="e.g. Maverick Steel" 
                />
              </div>
              <div className="flex flex-col gap-2">
                <label className="font-bold text-xs uppercase tracking-wider text-gray-800">Email Address *</label>
                <input 
                  type="email" name="email" required
                  value={formData.email} onChange={handleInputChange}
                  className="w-full border-2 border-gray-300 p-4 font-medium focus:outline-none focus:border-black focus:ring-4 focus:ring-black/10 transition-all"
                  placeholder="e.g. player@example.com" 
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="flex flex-col gap-2">
                <label className="font-bold text-xs uppercase tracking-wider text-gray-800">Contact Number *</label>
                <input 
                  type="tel" name="contactNumber" required
                  value={formData.contactNumber} onChange={handleInputChange}
                  className="w-full border-2 border-gray-300 p-4 font-medium focus:outline-none focus:border-black focus:ring-4 focus:ring-black/10 transition-all"
                  placeholder="+1 (555) 000-0000" 
                />
              </div>
              <div className="flex flex-col gap-2">
                <label className="font-bold text-xs uppercase tracking-wider text-gray-800">Age *</label>
                <input 
                  type="number" name="age" required min="11" max="80"
                  value={formData.age} onChange={handleInputChange}
                  className="w-full border-2 border-gray-300 p-4 font-medium focus:outline-none focus:border-black focus:ring-4 focus:ring-black/10 transition-all"
                  placeholder="11+" 
                />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="flex flex-col gap-2 relative">
                <label className="font-bold text-xs uppercase tracking-wider text-gray-800">Batting Style</label>
                <select 
                  name="battingStyle"
                  value={formData.battingStyle} onChange={handleInputChange}
                  className="w-full border-2 border-gray-300 p-4 font-medium focus:outline-none focus:border-black focus:ring-4 focus:ring-black/10 transition-all appearance-none bg-white"
                >
                  <option value="Right Hand">Right Hand</option>
                  <option value="Left Hand">Left Hand</option>
                </select>
                <ChevronDown className="absolute right-4 top-[38px] text-gray-500 pointer-events-none" />
              </div>
              <div className="flex flex-col gap-2 relative">
                <label className="font-bold text-xs uppercase tracking-wider text-gray-800">Batting Position</label>
                <select 
                  name="battingPosition"
                  value={formData.battingPosition} onChange={handleInputChange}
                  className="w-full border-2 border-gray-300 p-4 font-medium focus:outline-none focus:border-black focus:ring-4 focus:ring-black/10 transition-all appearance-none bg-white"
                >
                  <option value="Top Order">Top Order</option>
                  <option value="Middle Order">Middle Order</option>
                  <option value="Finisher">Finisher</option>
                </select>
                <ChevronDown className="absolute right-4 top-[38px] text-gray-500 pointer-events-none" />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="flex flex-col gap-2 relative">
                <label className="font-bold text-xs uppercase tracking-wider text-gray-800">Bowling Style</label>
                <select 
                  name="bowlingStyle"
                  value={formData.bowlingStyle} onChange={handleInputChange}
                  className="w-full border-2 border-gray-300 p-4 font-medium focus:outline-none focus:border-black focus:ring-4 focus:ring-black/10 transition-all appearance-none bg-white"
                >
                  <option value="Fast">Fast</option>
                  <option value="Spin">Spin</option>
                  <option value="Medium">Medium</option>
                  <option value="Not a Bowler">Not a Bowler</option>
                </select>
                <ChevronDown className="absolute right-4 top-[38px] text-gray-500 pointer-events-none" />
              </div>
              <div className="flex flex-col gap-2 justify-center bg-gray-50 p-4 border border-gray-200">
                <label className="font-bold text-xs uppercase tracking-wider text-gray-800 mb-1">Primary Field Role</label>
                <div className="flex flex-col sm:flex-row gap-6">
                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input 
                      type="radio" name="primaryFieldRole" value="Wicketkeeper"
                      checked={formData.primaryFieldRole === 'Wicketkeeper'} onChange={handleInputChange}
                      className="w-5 h-5 text-red-600 border-2 border-gray-400 focus:ring-red-600" 
                    />
                    <span className="font-bold text-gray-600 group-hover:text-black transition-colors uppercase tracking-wide text-sm">Wicketkeeper</span>
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input 
                      type="radio" name="primaryFieldRole" value="Fielder"
                      checked={formData.primaryFieldRole === 'Fielder'} onChange={handleInputChange}
                      className="w-5 h-5 text-red-600 border-2 border-gray-400 focus:ring-red-600" 
                    />
                    <span className="font-bold text-gray-600 group-hover:text-black transition-colors uppercase tracking-wide text-sm">Fielder</span>
                  </label>
                </div>
              </div>
            </div>

              <div className="flex flex-col gap-2">
                <label className="font-bold text-xs uppercase tracking-wider text-gray-800">Additional Career Details</label>
                <textarea 
                  name="careerDetails"
                  value={formData.careerDetails} onChange={handleInputChange}
                  className="w-full border-2 border-gray-300 p-4 font-medium focus:outline-none focus:border-black focus:ring-4 focus:ring-black/10 transition-all resize-none" 
                  placeholder="Mention previous league experience or special skills..." 
                  rows={4}
                ></textarea>
              </div>

              <div className="space-y-8 pt-6 border-t-2 border-gray-200">
                <div className="flex flex-col gap-4">
                  <h3 className="font-[Anton] text-2xl uppercase text-[#410001] border-b-2 border-gray-200 w-fit pb-1 pr-8">Jersey Details</h3>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="flex flex-col gap-2 relative">
                    <label className="font-bold text-xs uppercase tracking-wider text-gray-800">Jersey Size</label>
                    <select 
                      name="jerseySize" required
                      value={formData.jerseySize} onChange={handleInputChange}
                      className="w-full border-2 border-gray-300 p-4 font-medium focus:outline-none focus:border-black focus:ring-4 focus:ring-black/10 transition-all appearance-none bg-white"
                    >
                      <option value="Small">Small</option>
                      <option value="Medium">Medium</option>
                      <option value="Large">Large</option>
                      <option value="XL">XL</option>
                      <option value="XXL">XXL</option>
                    </select>
                    <ChevronDown className="absolute right-4 top-[38px] text-gray-500 pointer-events-none" />
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="font-bold text-xs uppercase tracking-wider text-gray-800">Jersey Name</label>
                    <input 
                      type="text" name="jerseyName" required
                      value={formData.jerseyName} onChange={handleInputChange}
                      className="w-full border-2 border-gray-300 p-4 font-medium focus:outline-none focus:border-black focus:ring-4 focus:ring-black/10 transition-all uppercase" 
                      placeholder="e.g. MAVERICK" 
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="font-bold text-xs uppercase tracking-wider text-gray-800">Jersey Number</label>
                    <input 
                      type="number" name="jerseyNumber" required min="0" max="99"
                      value={formData.jerseyNumber} onChange={handleInputChange}
                      className="w-full border-2 border-gray-300 p-4 font-medium focus:outline-none focus:border-black focus:ring-4 focus:ring-black/10 transition-all" 
                      placeholder="0-99" 
                    />
                  </div>
                </div>
              </div>

              <button 
                type="submit" 
                disabled={isSubmitting}
                className="w-full bg-[#410001] text-white py-6 font-[Anton] text-2xl uppercase tracking-wider shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-black transition-all active:translate-y-1 active:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] mt-8 disabled:opacity-70 flex items-center justify-center gap-3"
              >
                {isSubmitting ? <Activity className="animate-spin" /> : 'Complete Registration'}
              </button>
            </form>
            </>
          )}
        </div>
      </section>
      </>
      ) : (
      <section className="py-24 px-4 md:px-12 max-w-7xl mx-auto min-h-screen">
         <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4 mb-8 border-b-4 border-black pb-4">
            <div>
              <div className="flex items-center gap-3 flex-wrap">
                <h2 className="font-[Anton] text-5xl md:text-6xl uppercase text-black tracking-tight leading-none">Draft Board</h2>
                <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-100 text-emerald-800 text-xs font-bold uppercase tracking-wider rounded-full border border-emerald-300 shadow-sm">
                  <span className="w-2 h-2 rounded-full bg-emerald-600 animate-pulse"></span>
                  Real-Time Live
                </span>
                <span className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold uppercase tracking-wider rounded-full border shadow-sm ${
                  isRegistrationOpen 
                    ? 'bg-emerald-50 text-emerald-800 border-emerald-300' 
                    : 'bg-red-50 text-red-800 border-red-300'
                }`}>
                  <span className={`w-2 h-2 rounded-full ${isRegistrationOpen ? 'bg-emerald-600 animate-pulse' : 'bg-red-600'}`}></span>
                  Registrations: {isRegistrationOpen ? 'Open' : 'Closed'}
                </span>
              </div>
              <p className="text-gray-600 text-xs md:text-sm font-semibold uppercase tracking-wider mt-2">
                Live scouting pool • {players.length} registered {players.length === 1 ? 'player' : 'players'}
                {players.length > 0 && filteredPlayers.length !== players.length && (
                  <span className="text-[#410001] font-bold ml-2">({filteredPlayers.length} shown)</span>
                )}
                {lastSyncTime && isAdmin && (
                  <span className="text-emerald-700 ml-2 font-medium">• Last live sync: {lastSyncTime}</span>
                )}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {isAdmin && (
                <>
                  <button 
                    onClick={handleToggleRegistrationStatus}
                    disabled={isUpdatingStatus}
                    className={`font-bold text-xs uppercase tracking-wider text-white border-2 border-black px-3.5 py-2 transition-colors shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 flex items-center gap-1.5 disabled:opacity-60 ${
                      isRegistrationOpen ? 'bg-red-700 hover:bg-red-800' : 'bg-emerald-600 hover:bg-emerald-700'
                    }`}
                    title={isRegistrationOpen ? 'Close registration form' : 'Re-open registration form'}
                  >
                    {isUpdatingStatus ? (
                      <Activity className="w-4 h-4 animate-spin" />
                    ) : isRegistrationOpen ? (
                      <Lock className="w-4 h-4" />
                    ) : (
                      <Unlock className="w-4 h-4" />
                    )}
                    <span>{isRegistrationOpen ? 'Close Form' : 'Re-Open Form'}</span>
                  </button>
                  {spreadsheetUrl && (
                    <a 
                      href={spreadsheetUrl} 
                      target="_blank" 
                      rel="noopener noreferrer" 
                      className="font-bold text-xs uppercase tracking-wider bg-white border-2 border-black text-black px-3.5 py-2 hover:bg-gray-100 transition-colors shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 flex items-center gap-1.5"
                    >
                      <FileSpreadsheet className="w-4 h-4 text-green-700" />
                      <span>Open Live Sheet</span>
                      <ExternalLink className="w-3.5 h-3.5 text-gray-500" />
                    </a>
                  )}
                  <button 
                    onClick={handleSyncGoogleSheets} 
                    disabled={isSyncingSheets}
                    className="font-bold text-xs uppercase tracking-wider bg-[#0f9d58] text-white border-2 border-black px-3.5 py-2 hover:bg-[#0b8043] transition-colors shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 active:shadow-none flex items-center gap-1.5 disabled:opacity-60"
                  >
                    <Zap className="w-4 h-4 fill-current" />
                    <span>{isSyncingSheets ? 'Syncing...' : (hasGoogleOAuthToken ? `Push to Sheets (${players.length})` : `Activate Live Sync (${players.length})`)}</span>
                  </button>
                  <button onClick={exportToCSV} disabled={players.length === 0} className="font-bold text-xs uppercase tracking-wider bg-white border-2 border-black text-black px-3.5 py-2 hover:bg-gray-50 transition-colors shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 flex items-center gap-1.5 disabled:opacity-50">
                    <Download className="w-4 h-4" />
                    <span>Export CSV</span>
                  </button>
                </>
              )}
              <button onClick={loadPlayers} className="font-bold text-xs uppercase tracking-wider bg-black text-white px-3.5 py-2 hover:bg-gray-800 transition-colors shadow-[2px_2px_0px_0px_rgba(255,0,0,1)] active:translate-y-0.5 flex items-center gap-1.5">
                <Activity className={isLoadingPlayers ? "animate-spin w-4 h-4" : "w-4 h-4"} />
                <span>Refresh</span>
              </button>
            </div>
         </div>

         {/* Admin Live Sync Notification Cards */}
         {isAdmin && !hasGoogleOAuthToken && (
           <div className="mb-6 p-4 bg-amber-50 border-2 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
             <div className="flex items-center gap-3">
               <Zap className="w-6 h-6 text-amber-600 shrink-0 animate-pulse" />
               <div>
                 <p className="text-sm font-bold text-black uppercase tracking-wide">
                   Live Google Sheets Sync: Ready to Activate
                 </p>
                 <p className="text-xs text-gray-700 font-medium">
                   Connect once with Google to push all {players.length} players to your spreadsheet and keep it updating in real time.
                 </p>
               </div>
             </div>
             <button
               onClick={handleSyncGoogleSheets}
               disabled={isSyncingSheets}
               className="font-[Anton] text-sm uppercase tracking-wider bg-[#0f9d58] text-white px-4 py-2 border-2 border-black hover:bg-[#0b8043] transition-colors shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 shrink-0 flex items-center gap-2"
             >
               <Zap className="w-4 h-4 fill-current" />
               <span>{isSyncingSheets ? 'Syncing...' : `Activate Live Sync (${players.length} Players)`}</span>
             </button>
           </div>
         )}

         {isAdmin && hasGoogleOAuthToken && (
           <div className="mb-6 p-3 bg-emerald-50 border-2 border-black shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] flex flex-wrap items-center justify-between gap-3 text-xs">
             <div className="flex items-center gap-2 font-bold text-emerald-900 uppercase tracking-wide">
               <span className="w-2.5 h-2.5 rounded-full bg-emerald-600 animate-pulse"></span>
               <span>⚡ Real-Time Google Sheets Streaming Active</span>
               <span className="text-gray-600 font-normal">({players.length} total players linked)</span>
             </div>
             {spreadsheetUrl && (
               <a
                 href={spreadsheetUrl}
                 target="_blank"
                 rel="noopener noreferrer"
                 className="font-bold uppercase tracking-wider text-emerald-800 hover:text-black flex items-center gap-1 underline underline-offset-2"
               >
                 <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-700" />
                 <span>Open Live Spreadsheet ↗</span>
               </a>
             )}
           </div>
         )}

         {/* Google Sheets Sync Alerts (Admin Only) */}
         {isAdmin && sheetsSyncSuccess && (
           <div className="mb-6 p-4 bg-emerald-50 border-2 border-emerald-600 shadow-[4px_4px_0px_0px_rgba(5,150,105,1)] flex items-center justify-between gap-4 animate-in fade-in duration-200">
             <div className="flex items-center gap-3">
               <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0" />
               <p className="text-xs md:text-sm font-bold text-emerald-900">{sheetsSyncSuccess}</p>
             </div>
             {spreadsheetUrl && (
               <a 
                 href={spreadsheetUrl} 
                 target="_blank" 
                 rel="noopener noreferrer" 
                 className="text-xs font-bold uppercase tracking-wider bg-emerald-700 text-white px-3 py-1 hover:bg-emerald-800 shrink-0 flex items-center gap-1 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]"
               >
                 <span>View Sheet</span>
                 <ExternalLink className="w-3 h-3" />
               </a>
             )}
           </div>
         )}

         {isAdmin && sheetsSyncError && (
           <div className="mb-6 p-4 bg-red-50 border-2 border-red-600 shadow-[4px_4px_0px_0px_rgba(220,38,38,1)] flex items-center justify-between gap-4 animate-in fade-in duration-200">
             <p className="text-xs md:text-sm font-bold text-red-900">{sheetsSyncError}</p>
             <button 
               onClick={() => setSheetsSyncError(null)} 
               className="text-xs font-bold text-red-700 hover:text-black uppercase px-2 py-1"
             >
               Dismiss
             </button>
           </div>
         )}
         
         {/* Draft Board Search & Filter Bar */}
         {players.length > 0 && (
           <div className="mb-8 p-4 bg-white border-2 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
             <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
               {/* Search Input */}
               <div className="relative flex-grow">
                 <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                 <input
                   type="text"
                   value={searchQuery}
                   onChange={(e) => setSearchQuery(e.target.value)}
                   placeholder="Search by name, jersey # (e.g. 7 or #7), role (fast, spin, batsman, keeper)..."
                   className="w-full pl-10 pr-10 py-2.5 border-2 border-gray-300 font-medium text-sm focus:outline-none focus:border-black focus:ring-2 focus:ring-black/10 transition-all placeholder:text-gray-400"
                 />
                 {searchQuery && (
                   <button
                     onClick={() => setSearchQuery('')}
                     className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-black p-0.5"
                     title="Clear search"
                   >
                     <X className="w-4 h-4" />
                   </button>
                 )}
               </div>

               {/* Role Filter Pills */}
               <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0 scrollbar-none">
                 {[
                   { id: 'ALL', label: 'All Roles' },
                   { id: 'BATSMAN', label: 'Batsmen' },
                   { id: 'BOWLER', label: 'Bowlers' },
                   { id: 'ALL ROUNDER', label: 'All-Rounders' },
                   { id: 'WICKET KEEPER', label: 'Wicketkeepers' }
                 ].map((role) => (
                   <button
                     key={role.id}
                     onClick={() => setRoleFilter(role.id)}
                     className={`px-3 py-2 text-xs font-bold uppercase tracking-wider border-2 border-black transition-all whitespace-nowrap active:translate-y-0.5 ${
                       roleFilter === role.id
                         ? 'bg-[#410001] text-white shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]'
                         : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                     }`}
                   >
                     {role.label}
                   </button>
                 ))}
               </div>
             </div>

             {/* Active Filter Status */}
             {(searchQuery.trim() || roleFilter !== 'ALL') && (
               <div className="mt-3 pt-3 border-t border-gray-200 flex flex-wrap items-center justify-between gap-2 text-xs">
                 <span className="font-semibold text-gray-700">
                   Showing <span className="font-bold text-black">{filteredPlayers.length}</span> of {players.length} registered players
                   {searchQuery.trim() && <span> matching "<span className="font-bold text-black">{searchQuery}</span>"</span>}
                   {roleFilter !== 'ALL' && <span> with role <span className="font-bold text-black uppercase">{roleFilter}</span></span>}
                 </span>
                 <button
                   onClick={() => {
                     setSearchQuery('');
                     setRoleFilter('ALL');
                   }}
                   className="font-bold uppercase tracking-wider text-red-700 hover:text-black underline underline-offset-2 ml-auto"
                 >
                   Clear Filters
                 </button>
               </div>
             )}
           </div>
         )}
         
         {isLoadingPlayers && players.length === 0 ? (
            <div className="flex justify-center py-20">
              <Activity className="w-12 h-12 animate-spin text-red-700" />
            </div>
         ) : players.length === 0 ? (
            <div className="text-center py-20 border-2 border-dashed border-gray-400">
              <p className="text-xl font-medium text-gray-500 uppercase tracking-widest">No players registered yet</p>
            </div>
         ) : filteredPlayers.length === 0 ? (
            <div className="text-center py-16 bg-white border-2 border-black p-8 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
              <Search className="w-10 h-10 text-gray-400 mx-auto mb-3" />
              <p className="text-xl font-[Anton] text-black uppercase tracking-wide">No Players Found</p>
              <p className="text-sm text-gray-600 mt-1 max-w-md mx-auto">
                No players match your search criteria. Try a different keyword or reset filters.
              </p>
              <button 
                onClick={() => { setSearchQuery(''); setRoleFilter('ALL'); }} 
                className="mt-5 px-5 py-2.5 bg-black text-white text-xs font-bold uppercase tracking-wider hover:bg-gray-800 transition-colors shadow-[2px_2px_0px_0px_rgba(255,0,0,1)] active:translate-y-0.5"
              >
                Clear Search & Filters
              </button>
            </div>
         ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredPlayers.map((player) => {
                const cricketRole = getPlayerCricketRole(player);
                const roleBadgeColor =
                  cricketRole === 'Wicketkeeper' ? 'bg-[#410001] text-white' :
                  cricketRole === 'Batsman' ? 'bg-blue-900 text-white' :
                  cricketRole === 'Bowler' ? 'bg-emerald-800 text-white' :
                  'bg-amber-800 text-white';

                return (
                 <div key={player.id} className="bg-white border-2 border-black p-6 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] flex flex-col relative overflow-hidden">
                    <div className="absolute top-0 left-0 w-full h-1 bg-red-700"></div>
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <h3 className="font-[Anton] text-2xl uppercase tracking-wide truncate pr-2 max-w-[200px]" title={player.fullName}>{player.fullName}</h3>
                        {((player.jerseyNumber !== undefined && player.jerseyNumber !== '') || player.jerseyName) && (
                          <p className="text-[11px] font-bold text-gray-500 uppercase tracking-wider mt-0.5">
                            Jersey #{player.jerseyNumber ?? '--'} {player.jerseyName ? `• ${player.jerseyName}` : ''}
                          </p>
                        )}
                      </div>
                      <span className={`${roleBadgeColor} font-bold text-xs px-2.5 py-1 uppercase shrink-0 shadow-sm`}>{cricketRole}</span>
                    </div>
                    
                    <div className="space-y-2 mb-6 flex-grow">
                      <div className="flex justify-between border-b border-gray-100 pb-1">
                        <span className="text-gray-500 text-xs font-bold uppercase">Age</span>
                        <span className="font-medium text-sm">{player.age}</span>
                      </div>
                      <div className="flex justify-between border-b border-gray-100 pb-1">
                        <span className="text-gray-500 text-xs font-bold uppercase">Batting</span>
                        <span className="font-medium text-sm text-right">{player.battingStyle} <br/><span className="text-xs text-gray-500">({player.battingPosition})</span></span>
                      </div>
                      <div className="flex justify-between border-b border-gray-100 pb-1">
                        <span className="text-gray-500 text-xs font-bold uppercase">Bowling</span>
                        <span className="font-medium text-sm text-right">{player.bowlingStyle}</span>
                      </div>
                      {player.primaryFieldRole === 'Wicketkeeper' && (
                        <div className="flex justify-between border-b border-gray-100 pb-1">
                          <span className="text-gray-500 text-xs font-bold uppercase">Field Role</span>
                          <span className="font-medium text-sm text-right text-red-900 font-bold">Wicketkeeper</span>
                        </div>
                      )}
                    </div>
                    
                    <div className="bg-gray-50 p-3 border border-gray-200 mt-auto min-h-[60px]">
                       <p className="text-xs text-gray-600 italic line-clamp-2">"{player.careerDetails || 'No additional details provided.'}"</p>
                    </div>
                 </div>
              );})}
            </div>
         )}
      </section>
      )}

      {/* Visual Divider */}
      <div className="w-full h-24 bg-black flex items-center justify-center overflow-hidden">
        <div className="flex gap-12 animate-[pulse_4s_ease-in-out_infinite] whitespace-nowrap opacity-40">
          <span className="font-[Anton] text-3xl text-white uppercase tracking-widest">TRAIN HARD • PLAY HARD • WIN BIG • LIMITLESS • BEYOND PERFORMANCE •</span>
        </div>
      </div>

      {/* Footer / Positive Quote */}
      <footer className="w-full bg-black text-white border-t-2 border-gray-800 py-16 px-4 md:px-12 text-center">
        <div className="max-w-4xl mx-auto flex flex-col items-center justify-center gap-4">
          <div className="w-12 h-1 bg-red-700 mb-2"></div>
          <blockquote className="font-[Anton] text-2xl md:text-4xl uppercase tracking-wide text-white leading-relaxed">
            “Champions keep playing until they get it right. Play with passion, rise with pride.”
          </blockquote>
          <p className="text-gray-400 font-medium text-sm md:text-base tracking-widest uppercase mt-2">
            SSPL S3 • Dream Big. Play Fearless.
          </p>
        </div>
      </footer>
    </div>
  );
}
