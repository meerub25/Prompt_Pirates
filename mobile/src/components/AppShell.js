import { StatusBar } from 'expo-status-bar';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useFocusEffect, useRouter } from 'expo-router';
import NetInfo from '@react-native-community/netinfo';
import * as SecureStore from 'expo-secure-store';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';
import {
  apiRequest,
  cachedOrFetch,
  clearToken,
  friendlyError,
  getBaseUrl,
  getToken,
  saveToken,
  setBaseUrl
} from '../api';
import {
  enqueueAction,
  getOrCreateDeviceId,
  readCache,
  readQueue,
  readSyncResults,
  removeQueuedActions,
  saveSyncResults
} from '../storage';

const COLORS = {
  ink: '#0F172A',
  muted: '#475569',
  green: '#006C49',
  greenDark: '#00422B',
  greenPale: '#ECFDF5',
  canvas: '#F8FAFC',
  paper: '#FFFFFF',
  line: '#E2E8F0',
  gold: '#E9B44C',
  danger: '#A13C35',
  dangerPale: '#FFF0EE',
  blue: '#286B9A'
};

const ROLE_LABELS = {
  super_admin: 'Platform Super-Admin',
  league_organizer: 'League Organizer',
  club_manager: 'Club Manager',
  player: 'Player',
  viewer: 'General Viewer'
};

const ERROR_REASONS = {
  DUPLICATE_EVENT_ID: 'This event ID was already used for another action.',
  MATCH_EXISTS: 'This match has already been created.',
  INNINGS_COMPLETE: 'This innings has reached its configured limit.',
  SERIES_ALREADY_DECIDED: 'The series result is already decided.',
  VALIDATION_ERROR: 'Some action details were invalid.',
  ILLEGAL_TRANSITION: 'The match was not in a state that allows this action.',
  INVALID_COMPENSATION: 'The selected event cannot be corrected.',
  EVENT_NOT_FOUND: 'The event to correct no longer exists.',
  MATCH_NOT_IN_PROGRESS: 'The match was not in progress.',
  INVALID_BASE_VERSION: 'The server had a newer version of this match.',
  PLAYER_NOT_FOUND: 'That player could not be found.',
  NOT_IN_SQUAD: 'That player is not in the selected squad.',
  ROSTER_RULE_VIOLATION: 'The roster change does not meet the league rules.'
};

let syncInFlight = false;

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function money(minor) {
  return `PKR ${(Number(minor || 0) / 100).toFixed(2)}`;
}

function statusText(status) {
  return String(status || 'upcoming').replace(/_/g, ' ');
}

function formatTime(value) {
  if (!value) return 'Time not set';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function syncReason(result) {
  return ERROR_REASONS[result.error_code] || 'The server could not apply this action.';
}

function Field({ label, value, onChangeText, placeholder, keyboardType, secureTextEntry, multiline }) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#89968F"
        keyboardType={keyboardType || 'default'}
        secureTextEntry={secureTextEntry}
        multiline={multiline}
        textAlignVertical={multiline ? 'top' : 'center'}
        style={[styles.input, multiline && styles.multilineInput]}
        autoCapitalize={
          keyboardType === 'email-address' || keyboardType === 'url' || secureTextEntry
            ? 'none'
            : 'sentences'
        }
      />
    </View>
  );
}

function Button({ title, onPress, secondary, danger, disabled, small, accessibilityLabel }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || title}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.buttonSecondary,
        danger && styles.buttonDanger,
        small && styles.buttonSmall,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed
      ]}
    >
      <Text style={[styles.buttonText, secondary && styles.buttonSecondaryText]}>
        {title}
      </Text>
    </Pressable>
  );
}

function Card({ children, style }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

function Empty({ children }) {
  return (
    <Card style={styles.emptyCard}>
      <Text style={styles.emptyTitle}>Nothing to show yet</Text>
      <Text style={styles.bodyText}>{children}</Text>
    </Card>
  );
}

function AppShell({ route, matchId, fixture }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [online, setOnline] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [queue, setQueue] = useState([]);
  const [syncResults, setSyncResults] = useState([]);
  const [baseUrl, setBaseUrlState] = useState('http://10.0.2.2:8080');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const screen = ({
    login: 'Login',
    fixtures: 'Fixtures',
    match: 'Match detail',
    standings: 'Standings',
    club: 'Club profile',
    store: 'Store',
    roster: 'Roster',
    scoring: 'Scoring',
    sync: 'Sync status',
    settings: 'Settings'
  })[route] || 'Login';

  const tenant = user?.tenant_id === 'tenant-beta'
    ? { name: 'Beta Athletics', color: '#286B9A' }
    : { name: 'Alpha Sports', color: COLORS.green };

  const refreshQueue = useCallback(async () => {
    const [items, results] = await Promise.all([readQueue(), readSyncResults()]);
    setQueue(items);
    setSyncResults(results);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [storedBaseUrl, storedToken, storedUser] = await Promise.all([
          getBaseUrl(),
          getToken(),
          SecureStore.getItemAsync('nascon_user')
        ]);
        if (!active) return;
        setBaseUrlState(storedBaseUrl);
        if (storedToken && storedUser) {
          const parsed = JSON.parse(storedUser);
          setToken(storedToken);
          setUser(parsed);
        }
        await refreshQueue();
      } catch (loadError) {
        if (active) setError(friendlyError(loadError));
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => { active = false; };
  }, [refreshQueue]);

  useFocusEffect(useCallback(() => {
    refreshQueue().catch(loadError => setError(friendlyError(loadError)));
  }, [refreshQueue]));

  useEffect(() => {
    if (!ready) return;
    if (!user && !['Login', 'Settings'].includes(screen)) {
      router.replace('/login');
      return;
    }
    if (user && screen === 'Login') {
      router.replace('/fixtures');
      return;
    }
    if (screen === 'Roster' && user?.role !== 'club_manager') {
      router.replace('/fixtures');
      return;
    }
    if (screen === 'Scoring' && user?.role !== 'league_organizer') {
      router.replace('/fixtures');
    }
  }, [ready, router, screen, user]);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      setOnline(Boolean(state.isConnected && state.isInternetReachable !== false));
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (screen === 'Settings') {
        router.back();
        return true;
      }
      if (screen === 'Match detail') {
        router.back();
        return true;
      }
      if (user && screen !== 'Fixtures') {
        router.replace('/fixtures');
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [router, screen, user]);

  const syncPending = useCallback(async () => {
    if (!online || !token || syncInFlight) return;
    const pending = await readQueue();
    if (pending.length === 0) {
      await refreshQueue();
      return;
    }
    syncInFlight = true;
    setSyncing(true);
    setError('');
    try {
      const deviceId = await getOrCreateDeviceId();
      for (let offset = 0; offset < pending.length; offset += 100) {
        const batch = pending.slice(offset, offset + 100);
        const response = await apiRequest('/api/v1/sync', {
          method: 'POST',
          token,
          body: { device_id: deviceId, actions: batch }
        });
        if (!Array.isArray(response.results) || response.results.length !== batch.length) {
          throw new Error('The server did not return a result for every queued action.');
        }
        const results = (response.results || []).map(result => ({
          action_id: result.action_id,
          status: result.status === 'applied' || result.status === 'duplicate'
            ? result.status
            : 'rejected',
          reason: result.status === 'applied'
            ? 'The server accepted this action.'
            : result.status === 'duplicate'
              ? 'This action had already been received by the server.'
              : syncReason(result)
        }));
        await saveSyncResults(results);
        await removeQueuedActions(batch);
      }
      await refreshQueue();
      setNotice('Sync finished. Your action results are shown below.');
    } catch (syncError) {
      setError(friendlyError(syncError));
      await refreshQueue();
    } finally {
      syncInFlight = false;
      setSyncing(false);
    }
  }, [online, token, refreshQueue]);

  useFocusEffect(useCallback(() => {
    if (online && token && queue.length > 0 && !syncing) {
      const timeout = setTimeout(() => { syncPending(); }, 350);
      return () => clearTimeout(timeout);
    }
    return undefined;
  }, [online, token, queue.length, syncing, syncPending]));

  const enqueue = useCallback(async action => {
    await enqueueAction(action);
    await refreshQueue();
    setNotice(online
      ? 'Action saved. Syncing it with the server now.'
      : 'Action saved as pending. It will sync when you are back online.');
    if (online) setTimeout(() => { syncPending(); }, 0);
  }, [online, refreshQueue, syncPending]);

  const logout = useCallback(async () => {
    await clearToken();
    await SecureStore.deleteItemAsync('nascon_user');
    setToken(null);
    setUser(null);
    router.replace('/login');
    setNotice('You have signed out.');
  }, [router]);

  const openSettings = () => {
    setError('');
    router.push('/settings');
  };

  if (!ready) {
    return (
      <SafeAreaView style={styles.loadingScreen}>
        <ActivityIndicator size="large" color={COLORS.green} />
        <Text style={styles.bodyText}>Getting NaSCon ready…</Text>
      </SafeAreaView>
    );
  }

  const navigation = [
    { label: 'Fixtures', shortLabel: 'Matches', icon: '●', path: '/fixtures' },
    { label: 'Standings', shortLabel: 'Tables', icon: '▤', path: '/standings' },
    { label: 'Club profile', shortLabel: 'Club', icon: '⌂', path: '/club' },
    { label: 'Store', shortLabel: 'Store', icon: '▣', path: '/store' },
    ...(user?.role === 'club_manager'
      ? [{ label: 'Roster', shortLabel: 'Roster', icon: '⇄', path: '/roster' }]
      : []),
    ...(user?.role === 'league_organizer'
      ? [{ label: 'Scoring', shortLabel: 'Scoring', icon: '＋', path: '/scoring' }]
      : []),
    { label: 'Sync status', shortLabel: 'Sync', icon: '↻', path: '/sync' }
  ];

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <View style={styles.topBand}>
        <View style={styles.brandRow}>
          <View style={[styles.brandMark, { backgroundColor: tenant.color }]}>
            <Text style={styles.brandMarkText}>N</Text>
          </View>
          <View style={styles.brandCopy}>
            <View style={styles.brandTitleRow}>
              <Text numberOfLines={1} style={styles.brandTitle}>
                {screen === 'Fixtures' ? 'Live Fixtures' : screen}
              </Text>
              <Text style={styles.yearBadge}>’26</Text>
            </View>
            <View style={styles.brandMetaRow}>
              <Text numberOfLines={1} style={styles.tenantBadge}>{tenant.name}</Text>
              <View style={styles.headerSyncBadge}>
                <View style={[
                  styles.headerSyncDot,
                  { backgroundColor: syncing ? COLORS.gold : online ? '#10B981' : '#94A3B8' }
                ]} />
                <Text style={styles.headerSyncText}>
                  {syncing ? 'Syncing' : online ? 'Online' : 'Offline'}
                </Text>
              </View>
            </View>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open server settings"
            onPress={openSettings}
            style={styles.headerSettings}
          >
            <Text style={styles.headerSettingsText}>•••</Text>
          </Pressable>
        </View>
        {user ? (
          <View style={styles.identityRow}>
            <Text numberOfLines={1} style={styles.identityText}>
              {ROLE_LABELS[user.role] || user.role} · {user.email}
            </Text>
            {queue.length > 0 && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${queue.length} pending actions. Open sync status`}
                onPress={() => router.replace('/sync')}
                style={styles.pendingBadge}
              >
                <Text style={styles.pendingBadgeText}>{queue.length} pending</Text>
              </Pressable>
            )}
          </View>
        ) : (
          <View style={styles.identityRow}>
            <Text style={styles.identityText}>Competition companion</Text>
          </View>
        )}
      </View>

      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {error ? (
          <View accessibilityRole="alert" style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable onPress={() => setError('')} style={styles.dismissButton}>
              <Text style={styles.dismissText}>Dismiss</Text>
            </Pressable>
          </View>
        ) : null}
        {notice ? (
          <View accessibilityRole="text" style={styles.noticeBanner}>
            <Text style={styles.noticeText}>{notice}</Text>
            <Pressable onPress={() => setNotice('')} style={styles.dismissButton}>
              <Text style={styles.noticeText}>Dismiss</Text>
            </Pressable>
          </View>
        ) : null}
        <ScrollView
          key={screen}
          style={styles.scroll}
          contentContainerStyle={styles.screenContent}
          keyboardShouldPersistTaps="handled"
        >
          {screen === 'Login' && (
            <LoginScreen
              onLogin={async result => {
                try {
                  await saveToken(result.token);
                  await SecureStore.setItemAsync('nascon_user', JSON.stringify({
                    ...result.user,
                    role: result.role,
                    tenant_id: result.tenant_id
                  }));
                  setToken(result.token);
                  setUser({
                    ...result.user,
                    role: result.role,
                    tenant_id: result.tenant_id
                  });
                  setError('');
                  router.replace('/fixtures');
                  setNotice(`Welcome, ${ROLE_LABELS[result.role] || 'NaSCon user'}.`);
                } catch (saveError) {
                  setError(friendlyError(saveError));
                }
              }}
              setError={setError}
            />
          )}
          {screen === 'Settings' && (
            <SettingsScreen
              initialUrl={baseUrl}
              onSaved={value => {
                setBaseUrlState(value);
                router.back();
                setNotice('Server address saved on this device.');
              }}
              onCancel={() => router.back()}
              onLogout={logout}
              setError={setError}
            />
          )}
          {screen === 'Fixtures' && user && (
            <FixturesScreen
              token={token}
              leagueId={user.own_league_id || 'league-alpha-1'}
              pendingCount={queue.length}
              onOpenMatch={match => router.push({
                pathname: '/match/[match_id]',
                params: {
                  match_id: match.match_id,
                  home: match.home,
                  away: match.away,
                  status: match.status,
                  score_home: String(match.score?.home ?? 0),
                  score_away: String(match.score?.away ?? 0)
                }
              })}
              setError={setError}
            />
          )}
          {screen === 'Match detail' && user && matchId && (
            <MatchDetailScreen
              token={token}
              matchId={matchId}
              fixture={fixture}
              onBack={() => router.back()}
              onBuy={() => router.push('/store')}
              setError={setError}
            />
          )}
          {screen === 'Standings' && user && (
            <StandingsScreen
              token={token}
              leagueId={user.own_league_id || 'league-alpha-1'}
              setError={setError}
            />
          )}
          {screen === 'Club profile' && user && (
            <ClubScreen
              token={token}
              clubId={user.own_club_id || 'club-alpha-1'}
              setError={setError}
            />
          )}
          {screen === 'Store' && user && (
            <StoreScreen
              token={token}
              user={user}
              setError={setError}
              setNotice={setNotice}
            />
          )}
          {screen === 'Roster' && user?.role === 'club_manager' && (
            <RosterScreen
              user={user}
              online={online}
              enqueue={enqueue}
              setError={setError}
            />
          )}
          {screen === 'Scoring' && user?.role === 'league_organizer' && (
            <ScoringScreen
              token={token}
              leagueId={user.own_league_id || 'league-alpha-1'}
              online={online}
              enqueue={enqueue}
              setError={setError}
            />
          )}
          {screen === 'Sync status' && (
            <SyncScreen
              queue={queue}
              results={syncResults}
              online={online}
              syncing={syncing}
              sync={syncPending}
            />
          )}
          {user && !navigation.some(item => item.label === screen) && screen !== 'Match detail' && screen !== 'Settings' && (
            <Empty>This area is not available for your account.</Empty>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
      {user && screen !== 'Settings' && (
        <View accessibilityRole="tablist" style={styles.bottomNav}>
          {navigation.map(item => (
            <Pressable
              key={item.path}
              accessibilityRole="tab"
              accessibilityLabel={item.label}
              accessibilityState={{ selected: screen === item.label }}
              onPress={() => { setError(''); setNotice(''); router.replace(item.path); }}
              style={styles.bottomNavItem}
            >
              <Text style={[
                styles.bottomNavIcon,
                screen === item.label && styles.bottomNavIconSelected
              ]}>{item.icon}</Text>
              <Text
                numberOfLines={1}
                style={[
                  styles.bottomNavText,
                  screen === item.label && styles.bottomNavTextSelected
                ]}
              >
                {item.shortLabel}{item.label === 'Sync status' && queue.length > 0 ? ` ${queue.length}` : ''}
              </Text>
              {screen === item.label && <View style={styles.bottomNavIndicator} />}
            </Pressable>
          ))}
        </View>
      )}
    </SafeAreaView>
  );
}

function LoginScreen({ onLogin, setError }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  return (
    <View style={styles.screen}>
      <Text style={styles.eyebrow}>Welcome back</Text>
      <Text style={styles.title}>Sign in to your team</Text>
      <Text style={styles.bodyText}>Your fixtures, scores and club tools in one place.</Text>
      <Card style={styles.formCard}>
        <Field label="Email address" value={email} onChangeText={setEmail} placeholder="you@example.com" keyboardType="email-address" />
        <Field label="Password" value={password} onChangeText={setPassword} placeholder="Enter your password" secureTextEntry />
        <Button
          title={loading ? 'Signing in…' : 'Sign in'}
          disabled={loading || !email.trim() || !password}
          onPress={async () => {
            setLoading(true);
            setError('');
            try {
              const result = await apiRequest('/api/v1/auth/login', {
                method: 'POST',
                body: { email: email.trim(), password }
              });
              await onLogin(result);
            } catch (loginError) {
              setError(friendlyError(loginError));
            } finally {
              setLoading(false);
            }
          }}
        />
        {loading && <ActivityIndicator color={COLORS.green} style={styles.inlineSpinner} />}
      </Card>
      <Text style={styles.caption}>Server: change the address in Settings to connect over your laptop’s Wi-Fi.</Text>
    </View>
  );
}

function SettingsScreen({ initialUrl, onSaved, onCancel, onLogout, setError }) {
  const [value, setValue] = useState(initialUrl);
  const [saving, setSaving] = useState(false);
  return (
    <View style={styles.screen}>
      <Text style={styles.eyebrow}>Connection</Text>
      <Text style={styles.title}>Server settings</Text>
      <Text style={styles.bodyText}>Use 10.0.2.2 on the Android emulator, or your laptop’s LAN address on a phone.</Text>
      <Card style={styles.formCard}>
        <Field label="Backend base URL" value={value} onChangeText={setValue} placeholder="http://10.0.2.2:8080" keyboardType="url" />
        <Button title={saving ? 'Saving…' : 'Save address'} disabled={saving} onPress={async () => {
          setSaving(true);
          try {
            await setBaseUrl(value);
            onSaved(value.trim().replace(/\/+$/, ''));
          } catch (saveError) {
            setError(friendlyError(saveError));
          } finally {
            setSaving(false);
          }
        }} />
        <Button title="Back" secondary onPress={onCancel} />
        <Button title="Sign out" danger onPress={onLogout} />
      </Card>
    </View>
  );
}

function FixturesScreen({ token, leagueId, pendingCount, onOpenMatch, setError }) {
  const [matches, setMatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [cached, setCached] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await cachedOrFetch(
        `/api/v1/matches?league_id=${encodeURIComponent(leagueId)}`,
        token,
        `fixtures:${leagueId}`
      );
      setMatches(response.data.matches || []);
      setCached(response.cached);
      if (!response.cached) setError('');
    } catch (loadError) {
      setError(friendlyError(loadError));
      setMatches([]);
    } finally {
      setLoading(false);
    }
  }, [leagueId, token, setError]);
  useEffect(() => { load(); }, [load]);
  const statuses = [...new Set(matches.map(match => String(match.status || 'upcoming').toLowerCase()))];
  const filteredMatches = matches.filter(match => (
    statusFilter === 'all' || String(match.status || 'upcoming').toLowerCase() === statusFilter
  ));
  const featuredMatch = filteredMatches.find(match => (
    ['in_progress', 'live'].includes(String(match.status || '').toLowerCase())
  )) || filteredMatches[0];
  const otherMatches = featuredMatch
    ? filteredMatches.filter(match => match.match_id !== featuredMatch.match_id)
    : [];
  return (
    <View style={styles.screen}>
      <View style={styles.telemetryBanner}>
        <View style={styles.telemetryLeft}>
          <View style={[styles.telemetryDot, cached && styles.telemetryDotOffline]} />
          <Text style={styles.telemetryText}>
            {cached ? 'Saved fixtures · offline cache' : 'Fixtures · live API'}
          </Text>
        </View>
        <Text style={styles.telemetryQueue}>SQLite · {pendingCount} pending</Text>
      </View>
      <View style={styles.fixtureHeading}>
        <View style={styles.flexOne}>
          <Text style={styles.eyebrow}>League {leagueId}</Text>
          <Text style={styles.title}>Match centre</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh fixtures"
          onPress={load}
          style={styles.refreshButton}
        >
          <Text style={styles.refreshButtonText}>↻</Text>
        </Pressable>
      </View>
      {statuses.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          {['all', ...statuses].map(status => (
            <Pressable
              key={status}
              accessibilityRole="button"
              accessibilityState={{ selected: statusFilter === status }}
              onPress={() => setStatusFilter(status)}
              style={[styles.filterChip, statusFilter === status && styles.filterChipSelected]}
            >
              <Text style={[styles.filterChipText, statusFilter === status && styles.filterChipTextSelected]}>
                {status === 'all' ? 'All matches' : statusText(status)}
              </Text>
              {status !== 'all' && (
                <Text style={[styles.filterCount, statusFilter === status && styles.filterCountSelected]}>
                  {matches.filter(match => String(match.status || 'upcoming').toLowerCase() === status).length}
                </Text>
              )}
            </Pressable>
          ))}
        </ScrollView>
      )}
      {cached && <CacheNote />}
      {loading && <Loading label="Loading fixtures…" />}
      {!loading && matches.length === 0 && <Empty>No matches are scheduled for this league yet. Check back after fixtures are published.</Empty>}
      {!loading && matches.length > 0 && filteredMatches.length === 0 && (
        <Empty>There are no {statusText(statusFilter)} matches. Choose another status filter.</Empty>
      )}
      {featuredMatch && (
        <Pressable
          onPress={() => onOpenMatch(featuredMatch)}
          accessibilityRole="button"
          accessibilityLabel={`Open match ${featuredMatch.home} versus ${featuredMatch.away}`}
          style={styles.matchPress}
        >
          <Card style={styles.featuredMatchCard}>
            <View style={styles.featuredMatchHeader}>
              <View style={styles.featuredLiveBadge}>
                <View style={styles.featuredLiveDot} />
                <Text style={styles.featuredLiveText}>
                  {statusText(featuredMatch.status)}
                </Text>
              </View>
              <Text numberOfLines={1} style={styles.matchId}>{featuredMatch.match_id}</Text>
            </View>
            <View style={styles.featuredTeamsRow}>
              <View style={styles.featuredTeam}>
                <View style={styles.teamEmblem}>
                  <Text style={styles.teamEmblemText}>
                    {String(featuredMatch.home || 'H').slice(0, 2).toUpperCase()}
                  </Text>
                </View>
                <Text numberOfLines={2} style={styles.featuredTeamName}>{featuredMatch.home}</Text>
              </View>
              <View style={styles.featuredScoreBlock}>
                <View style={styles.featuredScorePill}>
                  <Text style={styles.featuredScore}>
                    {featuredMatch.score?.home ?? 0}
                  </Text>
                  <Text style={styles.featuredScoreDivider}>:</Text>
                  <Text style={styles.featuredScore}>
                    {featuredMatch.score?.away ?? 0}
                  </Text>
                </View>
                <Text style={styles.featuredTime}>
                  {formatTime(featuredMatch.scheduled_at || featuredMatch.start_time || featuredMatch.time)}
                </Text>
              </View>
              <View style={styles.featuredTeam}>
                <View style={styles.teamEmblem}>
                  <Text style={styles.teamEmblemText}>
                    {String(featuredMatch.away || 'A').slice(0, 2).toUpperCase()}
                  </Text>
                </View>
                <Text numberOfLines={2} style={styles.featuredTeamName}>{featuredMatch.away}</Text>
              </View>
            </View>
            <View style={styles.featuredMatchFooter}>
              <Text style={styles.featuredFooterText}>Open match details</Text>
              <Text style={styles.featuredArrow}>›</Text>
            </View>
          </Card>
        </Pressable>
      )}
      {otherMatches.length > 0 && (
        <View style={styles.fixtureList}>
          <View style={styles.rowBetween}>
            <Text style={styles.sectionHeading}>Other fixtures</Text>
            <Text style={styles.fixtureCount}>{otherMatches.length} matches</Text>
          </View>
        </View>
      )}
      {otherMatches.map(match => (
        <Pressable key={match.match_id} onPress={() => onOpenMatch(match)} accessibilityRole="button" style={styles.matchPress}>
          <Card style={styles.compactMatchCard}>
            <View style={styles.compactMatchInfo}>
              <View style={styles.compactMatchMeta}>
                <Text numberOfLines={1} style={styles.matchId}>{match.match_id}</Text>
              <StatusPill value={match.status} />
              </View>
              <Text style={styles.compactMatchDate}>
                {formatTime(match.scheduled_at || match.start_time || match.time)}
              </Text>
            </View>
            <View style={styles.compactTeamsRow}>
              <View style={styles.compactTeamNames}>
                <Text numberOfLines={1} style={styles.teamName}>{match.home}</Text>
                <Text numberOfLines={1} style={styles.teamName}>{match.away}</Text>
              </View>
              <Text style={styles.score}>{match.score?.home ?? 0} – {match.score?.away ?? 0}</Text>
            </View>
          </Card>
        </Pressable>
      ))}
    </View>
  );
}

function MatchDetailScreen({ token, matchId, fixture, onBack, onBuy, setError }) {
  const [match, setMatch] = useState(null);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [cached, setCached] = useState(false);
  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const data = await apiRequest(`/api/v1/matches/${encodeURIComponent(matchId)}`, { token, cacheKey: `match:${matchId}` });
      setMatch(data);
      setCached(false);
      setError('');
    } catch (loadError) {
      const saved = await readCache(`match:${matchId}`);
      if (saved) {
        setMatch(saved);
        setCached(true);
      } else if (fixture) {
        setMatch({
          match_id: matchId,
          status: fixture.status,
          version: 0,
          events: [],
          home: { team_id: fixture.home, score: fixture.score?.home || 0 },
          away: { team_id: fixture.away, score: fixture.score?.away || 0 }
        });
      } else {
        setError(friendlyError(loadError));
      }
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, [fixture, matchId, token, setError]);
  useFocusEffect(useCallback(() => {
    load(true);
    apiRequest('/api/v1/products', { token })
      .then(response => setProducts(response.products || []))
      .catch(() => setProducts([]));
    const timer = setInterval(() => { load(false); }, 3000);
    return () => clearInterval(timer);
  }, [load, token]));
  return (
    <View style={styles.screen}>
      <Button title="‹  Fixtures" secondary small onPress={onBack} />
      <SectionTitle eyebrow="Live match centre" title="Match detail" subtitle={matchId} />
      {cached && <CacheNote />}
      {loading && <Loading label="Loading match…" />}
      {match && (
        <>
          <Card style={styles.liveScoreCard}>
            <View style={styles.matchMeta}>
              <StatusPill value={match.status} />
              <Text style={styles.caption}>Updates every 3 seconds</Text>
            </View>
            <View style={styles.largeScoreRow}>
              <TeamScore side={match.home} />
              <Text style={styles.largeDash}>–</Text>
              <TeamScore side={match.away} />
            </View>
            {match.outcome && match.outcome !== 'pending' && (
              <Text style={styles.outcomeText}>{statusText(match.outcome)}</Text>
            )}
          </Card>
          {products[0] && (
            <Card style={styles.productSpotlight}>
              <Text style={styles.eyebrow}>Featured merchandise</Text>
              <View style={styles.rowBetween}>
                <View style={styles.flexOne}>
                  <Text style={styles.cardTitle}>NaSCon team jersey</Text>
                  <Text style={styles.bodyText}>{money(products[0].price_minor)}</Text>
                </View>
                <Button title="Shop" small onPress={onBuy} />
              </View>
            </Card>
          )}
          <Text style={styles.sectionHeading}>Event timeline</Text>
          {(match.events || []).length === 0
            ? <Empty>No match events have been recorded yet.</Empty>
            : [...match.events].reverse().map((event, index) => (
              <Card key={`${event.event_id}-${index}`} style={styles.timelineCard}>
                <View style={styles.rowBetween}>
                  <Text style={styles.cardTitle}>{statusText(event.type)}</Text>
                  <Text style={styles.caption}>#{event.sequence}</Text>
                </View>
                <Text style={styles.bodyText}>{event.payload?.event_type || event.payload?.team_id || event.payload?.reason || 'Match update'}</Text>
                {event.compensated && <Text style={styles.compensatedText}>Corrected by a later event</Text>}
              </Card>
            ))}
        </>
      )}
    </View>
  );
}

function TeamScore({ side }) {
  return (
    <View style={styles.teamScore}>
      <Text numberOfLines={2} style={styles.teamScoreName}>{side?.team_id || 'Team'}</Text>
      <Text style={styles.teamScoreValue}>{side?.score ?? 0}</Text>
      {side?.overs != null && <Text style={styles.caption}>{side.overs} overs · {side.wickets} wickets</Text>}
    </View>
  );
}

function StandingsScreen({ token, leagueId, setError }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [cached, setCached] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await cachedOrFetch(
        `/api/v1/leagues/${encodeURIComponent(leagueId)}/standings`,
        token,
        `standings:${leagueId}`
      );
      setData(response.data);
      setCached(response.cached);
      if (!response.cached) setError('');
    } catch (loadError) {
      setError(friendlyError(loadError));
    } finally {
      setLoading(false);
    }
  }, [leagueId, token, setError]);
  useEffect(() => { load(); }, [load]);
  return (
    <View style={styles.screen}>
      <SectionTitle eyebrow="League table" title="Standings" subtitle={`League ${leagueId}`} />
      {cached && <CacheNote />}
      {loading && <Loading label="Loading standings…" />}
      {!loading && data && (!data.table || data.table.length === 0) && (
        <Empty>The table will appear after teams and fixtures are added to this league.</Empty>
      )}
      {(data?.table || []).map(row => (
        <Card key={row.team_id} style={styles.standingCard}>
          <View style={styles.rankBadge}><Text style={styles.rankText}>{row.rank}</Text></View>
          <View style={styles.standingMain}>
            <Text numberOfLines={1} style={styles.cardTitle}>{row.team_id}</Text>
            <Text style={styles.caption}>{row.played} played · {row.won}W {row.drawn}D {row.lost}L · diff {row.diff}</Text>
          </View>
          <View style={styles.pointsBlock}>
            <Text style={styles.pointsValue}>{row.points}</Text>
            <Text style={styles.caption}>points</Text>
          </View>
          <StatusPill value={row.status} compact />
        </Card>
      ))}
      <Button title="Refresh standings" secondary onPress={load} />
    </View>
  );
}

function ClubScreen({ token, clubId, setError }) {
  const [club, setClub] = useState(null);
  const [loading, setLoading] = useState(true);
  const [cached, setCached] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await cachedOrFetch(
        `/api/v1/clubs/${encodeURIComponent(clubId)}`,
        token,
        `club:${clubId}`
      );
      setClub(response.data);
      setCached(response.cached);
      if (!response.cached) setError('');
    } catch (loadError) {
      setError(friendlyError(loadError));
    } finally {
      setLoading(false);
    }
  }, [clubId, token, setError]);
  useEffect(() => { load(); }, [load]);
  return (
    <View style={styles.screen}>
      <SectionTitle eyebrow="Your club" title="Club profile" subtitle={clubId} />
      {cached && <CacheNote />}
      {loading && <Loading label="Loading club profile…" />}
      {!loading && !club && <Empty>Club details are not available yet. Check your connection and try again.</Empty>}
      {club && (
        <>
          <Card style={styles.clubHero}>
            <Text style={styles.eyebrow}>{club.tenant_id || 'NaSCon club'}</Text>
            <Text style={styles.clubName}>{club.name}</Text>
            <Text style={styles.bodyText}>{club.home_venue?.name || 'Home venue not listed'}</Text>
            {club.home_venue?.address && <Text style={styles.caption}>{club.home_venue.address}</Text>}
          </Card>
          <Text style={styles.sectionHeading}>Roster</Text>
          {(club.roster || []).length === 0
            ? <Empty>No players have been added to this club yet.</Empty>
            : club.roster.map((player, index) => (
              <Card key={player.player_id || `${player.name}-${index}`} style={styles.listCard}>
                <View style={styles.avatar}><Text style={styles.avatarText}>{String(player.name || player.player_id || '?').slice(0, 1).toUpperCase()}</Text></View>
                <View style={styles.flexOne}>
                  <Text style={styles.cardTitle}>{player.name || player.player_id}</Text>
                  <Text style={styles.caption}>{player.position || player.player_id || 'Player'}</Text>
                </View>
              </Card>
            ))}
          <Text style={styles.sectionHeading}>Staff</Text>
          {(club.staff || []).length === 0
            ? <Empty>No staff members are listed yet.</Empty>
            : club.staff.map((person, index) => (
              <Card key={`${person.role}-${person.name}-${index}`} style={styles.listCard}>
                <View style={styles.flexOne}>
                  <Text style={styles.cardTitle}>{person.name || person.role}</Text>
                  <Text style={styles.caption}>{person.role || 'Staff'}</Text>
                </View>
              </Card>
            ))}
        </>
      )}
    </View>
  );
}

function StoreScreen({ token, user, setError, setNotice }) {
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [discount, setDiscount] = useState('');
  const [gateway, setGateway] = useState('tok_success');
  const [receipt, setReceipt] = useState(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiRequest('/api/v1/products', { token });
      setProducts(response.products || []);
      setError('');
    } catch (loadError) {
      setError(friendlyError(loadError));
    } finally {
      setLoading(false);
    }
  }, [token, setError]);
  useEffect(() => { load(); }, [load]);
  const cartItems = useMemo(() => products
    .filter(item => cart[item.variant_id] > 0)
    .map(item => ({ ...item, quantity: cart[item.variant_id] })), [products, cart]);
  const subtotal = cartItems.reduce((sum, item) => sum + item.price_minor * item.quantity, 0);
  const discountMinor = discount.trim().toUpperCase() === 'WELCOME10' ? Math.floor(subtotal * 0.1) : 0;
  return (
    <View style={styles.screen}>
      <SectionTitle eyebrow="NaSCon merchandise" title={receipt ? 'Your receipt' : 'Store'} subtitle="Choose a size, add it to your cart, then check out." />
      {loading && <Loading label="Loading catalogue…" />}
      {!loading && products.length === 0 && <Empty>The catalogue is empty right now. Please check back later.</Empty>}
      {!receipt && products.map(product => (
        <Card key={product.variant_id} style={styles.productCard}>
          <View style={styles.rowBetween}>
            <View style={styles.flexOne}>
              <Text style={styles.cardTitle}>NaSCon team jersey</Text>
              <Text style={styles.caption}>Size {product.variant_id.split('-').pop()} · {product.stock} available</Text>
              <Text style={styles.priceText}>{money(product.price_minor)}</Text>
            </View>
            <View style={styles.quantityControl}>
              <Pressable accessibilityLabel="Remove one" style={styles.quantityButton} onPress={() => setCart(current => {
                const next = { ...current };
                if ((next[product.variant_id] || 0) <= 1) delete next[product.variant_id];
                else next[product.variant_id] -= 1;
                return next;
              })}><Text style={styles.quantitySymbol}>−</Text></Pressable>
              <Text style={styles.quantityValue}>{cart[product.variant_id] || 0}</Text>
              <Pressable accessibilityLabel="Add one" disabled={cart[product.variant_id] >= product.stock} style={styles.quantityButton} onPress={() => setCart(current => ({
                ...current,
                [product.variant_id]: (current[product.variant_id] || 0) + 1
              }))}><Text style={styles.quantitySymbol}>+</Text></Pressable>
            </View>
          </View>
        </Card>
      ))}
      {!receipt && (
        <Card style={styles.checkoutCard}>
          <Text style={styles.cardTitle}>Your cart</Text>
          {cartItems.length === 0
            ? <Text style={styles.bodyText}>Your cart is empty. Pick a jersey size above.</Text>
            : cartItems.map(item => <Text key={item.variant_id} style={styles.bodyText}>{item.variant_id} × {item.quantity} · {money(item.price_minor * item.quantity)}</Text>)}
          <Field label="Discount code (optional)" value={discount} onChangeText={setDiscount} placeholder="WELCOME10" />
          <Text style={styles.totalText}>Subtotal {money(subtotal)}</Text>
          {discountMinor > 0 && <Text style={styles.caption}>WELCOME10 discount −{money(discountMinor)}</Text>}
          <Text style={styles.totalText}>Total {money(subtotal - discountMinor)}</Text>
          <Text style={styles.fieldLabel}>Mock payment choice</Text>
          <View style={styles.choiceRow}>
            {['tok_success', 'tok_declined'].map(item => (
              <Pressable key={item} onPress={() => setGateway(item)} style={[styles.choice, gateway === item && styles.choiceSelected]}>
                <Text style={[styles.choiceText, gateway === item && styles.choiceTextSelected]}>
                  {item === 'tok_success' ? 'Approve' : 'Decline'}
                </Text>
              </Pressable>
            ))}
          </View>
          <Button title={busy ? 'Checking out…' : 'Confirm purchase'} disabled={busy || cartItems.length === 0} onPress={() => {
            Alert.alert('Place this order?', `Your total is ${money(subtotal - discountMinor)}.`, [
              { text: 'Review cart', style: 'cancel' },
              { text: 'Place order', onPress: async () => {
                setBusy(true);
                setError('');
                try {
                  const order = await apiRequest('/audit/v1/checkout', {
                    method: 'POST',
                    body: {
                      order_id: newId('order'),
                      customer_id: user.email,
                      items: cartItems.map(item => ({ variant_id: item.variant_id, quantity: item.quantity })),
                      discount_code: discount.trim() ? discount.trim().toUpperCase() : null,
                      payment: { token: gateway }
                    }
                  });
                  setReceipt(order.receipt);
                  setCart({});
                  setNotice('Purchase complete. Your receipt is ready.');
                } catch (checkoutError) {
                  setError(friendlyError(checkoutError));
                } finally {
                  setBusy(false);
                }
              } }
            ]);
          }} />
        </Card>
      )}
      {receipt && (
        <Card style={styles.receiptCard}>
          <View style={styles.receiptCheck}><Text style={styles.receiptCheckText}>✓</Text></View>
          <Text style={styles.receiptTitle}>Purchase complete</Text>
          <Text style={styles.bodyText}>Order {receipt.payload.order_id}</Text>
          <Text style={styles.receiptTotal}>{money(receipt.payload.total_minor)}</Text>
          <Text style={styles.caption}>Paid {formatTime(receipt.payload.paid_at)}</Text>
          <View style={styles.divider} />
          {receipt.payload.items.map(item => (
            <Text key={item.variant_id} style={styles.bodyText}>{item.variant_id} × {item.quantity} · {money(item.unit_price_minor * item.quantity)}</Text>
          ))}
          <Button title="Save / share PDF receipt" onPress={async () => {
            try {
              const path = `${FileSystem.cacheDirectory}${receipt.payload.order_id}.pdf`;
              await FileSystem.writeAsStringAsync(path, receipt.pdf_base64, {
                encoding: FileSystem.EncodingType.Base64
              });
              if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(path, { mimeType: 'application/pdf' });
              else setNotice('Receipt saved to the app cache.');
            } catch (receiptError) {
              setError(friendlyError(receiptError));
            }
          }} />
          <Button title="Shop again" secondary onPress={() => setReceipt(null)} />
        </Card>
      )}
    </View>
  );
}

function RosterScreen({ user, online, enqueue, setError }) {
  const [actionType, setActionType] = useState('transfer');
  const [playerId, setPlayerId] = useState(user.own_player_id || '');
  const [targetClub, setTargetClub] = useState('');
  const [busy, setBusy] = useState(false);
  const clubId = user.own_club_id || 'club-alpha-1';
  return (
    <View style={styles.screen}>
      <SectionTitle eyebrow="Club manager tools" title="Roster management" subtitle={`Managing ${clubId}`} />
      <Card style={styles.formCard}>
        <Text style={styles.fieldLabel}>Roster action</Text>
        <View style={styles.choiceWrap}>
          {['add', 'transfer', 'loan', 'release'].map(item => (
            <Pressable key={item} onPress={() => setActionType(item)} style={[styles.choice, actionType === item && styles.choiceSelected]}>
              <Text style={[styles.choiceText, actionType === item && styles.choiceTextSelected]}>{item[0].toUpperCase() + item.slice(1)}</Text>
            </Pressable>
          ))}
        </View>
        <Field label="Player ID" value={playerId} onChangeText={setPlayerId} placeholder="player-alpha-1" />
        {(actionType === 'transfer' || actionType === 'loan' || actionType === 'add') && (
          <Field label={actionType === 'add' ? 'Club to add player to' : 'Destination club'} value={targetClub} onChangeText={setTargetClub} placeholder="club-alpha-2" />
        )}
        <Text style={styles.helpText}>Roster changes are queued safely when offline and submitted in order when connected.</Text>
        <Button title={busy ? 'Saving…' : online ? `Submit ${actionType}` : `Queue ${actionType} for sync`} disabled={busy || !playerId.trim()} onPress={() => {
          Alert.alert('Confirm roster change', `Are you sure you want to ${actionType} ${playerId.trim()}?`, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Confirm', style: 'destructive', onPress: async () => {
              setBusy(true);
              setError('');
              try {
                const now = new Date().toISOString();
                await enqueue({
                  action_id: newId('action'),
                  type: 'roster_transfer',
                  queued_at: now,
                  base_version: 0,
                  payload: {
                    request_id: newId('request'),
                    league_id: user.own_league_id || 'league-alpha-1',
                    player_id: playerId.trim(),
                    type: actionType,
                    from_squad_id: actionType === 'add' ? targetClub.trim() || clubId : clubId,
                    ...(targetClub.trim() && actionType !== 'release' ? { to_squad_id: targetClub.trim() } : {}),
                    effective_date: now.slice(0, 10)
                  }
                });
              } catch (queueError) {
                setError(friendlyError(queueError));
              } finally {
                setBusy(false);
              }
            } }
          ]);
        }} />
        <Text style={styles.caption}>The server will validate and report the result for each action.</Text>
      </Card>
    </View>
  );
}

function ScoringScreen({ token, leagueId, online, enqueue, setError }) {
  const [matches, setMatches] = useState([]);
  const [matchId, setMatchId] = useState('');
  const [scoreData, setScoreData] = useState(null);
  const [teamId, setTeamId] = useState('');
  const [eventType, setEventType] = useState('');
  const [compensates, setCompensates] = useState('');
  const [reason, setReason] = useState('');
  const loadMatches = useCallback(async () => {
    try {
      const result = await apiRequest(`/api/v1/matches?league_id=${encodeURIComponent(leagueId)}`, {
        token,
        cacheKey: `fixtures:${leagueId}`
      });
      setMatches(result.matches || []);
      if (!matchId && result.matches?.[0]) setMatchId(result.matches[0].match_id);
    } catch (loadError) {
      const cached = await readCache(`fixtures:${leagueId}`);
      if (cached?.matches) {
        setMatches(cached.matches);
        if (!matchId && cached.matches[0]) setMatchId(cached.matches[0].match_id);
      } else {
        setError(friendlyError(loadError));
      }
    }
  }, [leagueId, matchId, token, setError]);
  useFocusEffect(useCallback(() => {
    loadMatches();
  }, [loadMatches]));
  const loadScore = useCallback(async () => {
    if (!matchId) return;
    let active = true;
    try {
      const score = await apiRequest(`/api/v1/matches/${encodeURIComponent(matchId)}`, {
        token,
        cacheKey: `match:${matchId}`
      });
      if (active) {
        setScoreData(score);
        if (!teamId) setTeamId(score.home.team_id);
      }
    } catch (loadError) {
      const cachedScore = await readCache(`match:${matchId}`);
      const fixture = matches.find(item => item.match_id === matchId);
      if (active && cachedScore) {
        setScoreData(cachedScore);
      } else if (active && fixture) {
        setScoreData({
          match_id: matchId,
          status: fixture.status,
          version: 0,
          events: [],
          home: { team_id: fixture.home, score: fixture.score?.home || 0 },
          away: { team_id: fixture.away, score: fixture.score?.away || 0 }
        });
      } else if (active && online) {
        setError(friendlyError(loadError));
      }
    }
  }, [matchId, matches, online, teamId, token, setError]);
  useFocusEffect(useCallback(() => {
    if (!matchId) return undefined;
    let active = true;
    const load = async () => {
      if (!active) return;
      await loadScore();
    };
    load();
    const timer = setInterval(load, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [loadScore, matchId]));
  const addEvent = async (type, payload) => {
    if (!scoreData) return;
    const now = new Date().toISOString();
    await enqueue({
      action_id: newId('action'),
      type: 'score_event',
      queued_at: now,
      base_version: scoreData.version || 0,
      payload: {
        event_id: newId('event'),
        match_id: matchId,
        type,
        payload
      }
    });
  };
  const scorableEvents = scoreData?.events?.filter(event =>
    ['score', 'discipline', 'tiebreak_winner'].includes(event.type) && !event.compensated
  ) || [];
  return (
    <View style={styles.screen}>
      <SectionTitle eyebrow="League organizer tools" title="Scoring entry" subtitle={online ? 'Score changes sync to the match event log.' : 'Actions are stored on this device until you reconnect.'} />
      <Card style={styles.formCard}>
        <Text style={styles.fieldLabel}>Choose match</Text>
        {matches.length === 0
          ? <Text style={styles.bodyText}>No league matches are available yet. Add a fixture before scoring.</Text>
          : matches.map(match => (
            <Pressable key={match.match_id} onPress={() => setMatchId(match.match_id)} style={[styles.selectRow, matchId === match.match_id && styles.selectRowSelected]}>
              <Text style={[styles.bodyText, matchId === match.match_id && styles.selectedText]}>{match.home} vs {match.away}</Text>
            </Pressable>
          ))}
      </Card>
      {scoreData && (
        <>
          <Card style={styles.formCard}>
            <Text style={styles.fieldLabel}>Team to credit</Text>
            {[scoreData.home.team_id, scoreData.away.team_id].map(id => (
              <Pressable key={id} onPress={() => setTeamId(id)} style={[styles.selectRow, teamId === id && styles.selectRowSelected]}>
                <Text style={[styles.bodyText, teamId === id && styles.selectedText]}>{id}</Text>
              </Pressable>
            ))}
            <Field label="Configured scoring event" value={eventType} onChangeText={setEventType} placeholder="Enter the event type from sport config" />
            <Button title={online ? 'Add score event' : 'Queue score event'} disabled={!eventType.trim()} onPress={() => {
              Alert.alert('Add this score?', `Credit ${teamId} with “${eventType.trim()}”?`, [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Add score', onPress: () => addEvent('score', { team_id: teamId, event_type: eventType.trim() }).catch(actionError => setError(friendlyError(actionError))) }
              ]);
            }} />
            {scoreData.status === 'upcoming' && (
              <Button title={online ? 'Start match' : 'Queue match start'} secondary onPress={() => addEvent('match_start', {}).catch(actionError => setError(friendlyError(actionError)))} />
            )}
          </Card>
          <Card style={styles.formCard}>
            <Text style={styles.cardTitle}>Correct an event</Text>
            <Text style={styles.helpText}>Corrections are appended to the log; the original event is never removed.</Text>
            {scorableEvents.length === 0
              ? <Text style={styles.bodyText}>There are no active scoring events to correct.</Text>
              : scorableEvents.map(event => (
                <Pressable key={event.event_id} onPress={() => setCompensates(event.event_id)} style={[styles.selectRow, compensates === event.event_id && styles.selectRowSelected]}>
                  <Text style={[styles.bodyText, compensates === event.event_id && styles.selectedText]}>#{event.sequence} · {event.payload.event_type || event.type} · {event.payload.team_id}</Text>
                </Pressable>
              ))}
            <Field label="Reason for correction" value={reason} onChangeText={setReason} placeholder="Explain what needs correcting" />
            <Button title={online ? 'Append correction' : 'Queue correction'} danger disabled={!compensates || !reason.trim()} onPress={() => {
              Alert.alert('Confirm correction', 'This adds a permanent correction event to the match history.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Append correction', style: 'destructive', onPress: () => addEvent('compensation', { compensates, reason: reason.trim() }).catch(actionError => setError(friendlyError(actionError))) }
              ]);
            }} />
          </Card>
        </>
      )}
    </View>
  );
}

function SyncScreen({ queue, results, online, syncing, sync }) {
  return (
    <View style={styles.screen}>
      <SectionTitle eyebrow="Offline tolerance" title="Sync status" subtitle="Your pending actions stay on this device until the server confirms them." />
      <Card style={styles.syncSummary}>
        <View style={styles.rowBetween}>
          <View style={styles.flexOne}>
            <Text style={styles.cardTitle}>{syncing ? 'Syncing actions…' : online ? 'You are online' : 'You are offline'}</Text>
            <Text style={styles.bodyText}>{queue.length} pending {queue.length === 1 ? 'action' : 'actions'}</Text>
          </View>
          {syncing ? <ActivityIndicator color={COLORS.green} /> : <StatusPill value={online ? 'online' : 'offline'} />}
        </View>
        {queue.length > 0 && <Button title={syncing ? 'Syncing…' : 'Sync now'} disabled={!online || syncing} onPress={sync} />}
      </Card>
      <Text style={styles.sectionHeading}>Pending queue</Text>
      {queue.length === 0
        ? <Empty>No pending actions. New offline scoring and roster actions will appear here.</Empty>
        : queue.map(action => (
          <Card key={action.action_id} style={styles.queueCard}>
            <View style={styles.rowBetween}>
              <Text style={styles.cardTitle}>{action.type === 'score_event' ? 'Scoring action' : 'Roster action'}</Text>
              <StatusPill value="pending" compact />
            </View>
            <Text style={styles.bodyText}>
              {action.type === 'score_event'
                ? `${statusText(action.payload.type)} · ${action.payload.payload?.event_type || action.payload.payload?.reason || ''}`
                : `${action.payload.type} · ${action.payload.player_id}`}
            </Text>
            <Text style={styles.caption}>Queued {formatTime(action.queued_at)}</Text>
          </Card>
        ))}
      <Text style={styles.sectionHeading}>Recent results</Text>
      {results.length === 0
        ? <Empty>Synced action results will be listed here with a plain-language explanation.</Empty>
        : results.map(result => (
          <Card key={result.action_id} style={styles.resultCard}>
            <View style={styles.rowBetween}>
              <Text style={styles.cardTitle}>{result.status === 'applied' ? 'Applied' : result.status === 'duplicate' ? 'Already received' : 'Needs attention'}</Text>
              <StatusPill value={result.status} compact />
            </View>
            <Text style={styles.bodyText}>{result.reason}</Text>
            <Text style={styles.caption}>{result.action_id}</Text>
          </Card>
        ))}
    </View>
  );
}

function SectionTitle({ eyebrow, title, subtitle }) {
  return (
    <View style={styles.sectionTitleWrap}>
      <Text style={styles.eyebrow}>{eyebrow}</Text>
      <Text style={styles.title}>{title}</Text>
      {!!subtitle && <Text style={styles.bodyText}>{subtitle}</Text>}
    </View>
  );
}

function StatusPill({ value, compact }) {
  const normalized = String(value || 'upcoming').toLowerCase();
  const isPositive = ['in_progress', 'completed', 'online', 'applied', 'clinched', 'paid'].includes(normalized);
  const isWarning = ['pending', 'still_possible', 'syncing'].includes(normalized);
  return (
    <View style={[
      styles.statusPill,
      compact && styles.statusPillCompact,
      isPositive ? styles.statusPositive : isWarning ? styles.statusWarning : styles.statusNeutral
    ]}>
      <Text style={styles.statusText}>{statusText(value)}</Text>
    </View>
  );
}

function CacheNote() {
  return (
    <View style={styles.cacheNote}>
      <Text style={styles.cacheNoteText}>Showing the last saved version from this device.</Text>
    </View>
  );
}

function Loading({ label }) {
  return (
    <View style={styles.loadingRow}>
      <ActivityIndicator color={COLORS.green} />
      <Text style={styles.bodyText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.canvas },
  loadingScreen: { flex: 1, backgroundColor: COLORS.canvas, alignItems: 'center', justifyContent: 'center', gap: 14 },
  topBand: {
    paddingHorizontal: 16,
    paddingTop: 7,
    paddingBottom: 5,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: COLORS.line,
    shadowColor: '#0F172A',
    shadowOpacity: 0.035,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2
  },
  brandRow: { minHeight: 54, flexDirection: 'row', alignItems: 'center' },
  brandMark: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  brandMarkText: { color: '#FFFFFF', fontSize: 22, fontWeight: '900' },
  brandCopy: { marginLeft: 10, flex: 1, minWidth: 0 },
  brandTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  brandTitle: { color: '#0F172A', fontSize: 17, fontWeight: '800', flexShrink: 1 },
  yearBadge: {
    color: COLORS.green,
    backgroundColor: '#ECFDF5',
    borderColor: '#A7F3D0',
    borderWidth: 1,
    overflow: 'hidden',
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 1,
    fontSize: 10,
    fontWeight: '800'
  },
  brandMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  tenantBadge: {
    color: COLORS.muted,
    backgroundColor: '#F1F5F9',
    borderColor: COLORS.line,
    borderWidth: 1,
    borderRadius: 5,
    overflow: 'hidden',
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontSize: 10,
    fontWeight: '700',
    maxWidth: 115
  },
  headerSyncBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 10,
    backgroundColor: '#ECFDF5',
    borderWidth: 1,
    borderColor: '#A7F3D0',
    paddingHorizontal: 6,
    paddingVertical: 2
  },
  headerSyncDot: { width: 6, height: 6, borderRadius: 3 },
  headerSyncText: { color: COLORS.greenDark, fontSize: 9, fontWeight: '800', textTransform: 'uppercase' },
  headerSettings: {
    width: 48,
    height: 48,
    borderRadius: 22,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center'
  },
  headerSettingsText: { color: COLORS.muted, fontSize: 19, fontWeight: '900', lineHeight: 24 },
  identityRow: { minHeight: 29, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  identityText: { color: COLORS.muted, fontSize: 10, flex: 1 },
  pendingBadge: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 9, backgroundColor: '#FFFBEB', borderRadius: 14, borderWidth: 1, borderColor: '#FDE68A' },
  pendingBadgeText: { color: '#92400E', fontSize: 10, fontWeight: '800' },
  bottomNav: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 64,
    paddingHorizontal: 3,
    paddingBottom: 2,
    backgroundColor: 'rgba(255,255,255,0.98)',
    borderTopWidth: 1,
    borderTopColor: COLORS.line,
    shadowColor: '#0F172A',
    shadowOpacity: 0.045,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: -2 },
    elevation: 8
  },
  bottomNavItem: { flex: 1, minWidth: 0, minHeight: 58, alignItems: 'center', justifyContent: 'center', gap: 2, position: 'relative' },
  bottomNavIcon: { color: '#64748B', fontSize: 20, lineHeight: 24, fontWeight: '700' },
  bottomNavIconSelected: { color: COLORS.green },
  bottomNavText: { color: '#64748B', fontSize: 9, fontWeight: '600', maxWidth: '100%' },
  bottomNavTextSelected: { color: COLORS.green, fontWeight: '800' },
  bottomNavIndicator: { position: 'absolute', bottom: 1, width: 20, height: 2, borderRadius: 1, backgroundColor: COLORS.green },
  body: { flex: 1 },
  scroll: { flex: 1 },
  screenContent: { padding: 14, paddingBottom: 22, flexGrow: 1 },
  screen: { width: '100%', maxWidth: 720, alignSelf: 'center', gap: 12 },
  sectionTitleWrap: { gap: 4, marginBottom: 4 },
  eyebrow: { color: COLORS.green, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, fontWeight: '800' },
  title: { color: COLORS.ink, fontSize: 28, lineHeight: 34, fontWeight: '800' },
  bodyText: { color: COLORS.muted, fontSize: 15, lineHeight: 22 },
  caption: { color: COLORS.muted, fontSize: 12, lineHeight: 18 },
  card: { backgroundColor: COLORS.paper, borderColor: COLORS.line, borderWidth: 1, borderRadius: 14, padding: 14, shadowColor: '#0F172A', shadowOpacity: 0.035, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 1 },
  formCard: { gap: 12 },
  fieldWrap: { gap: 6 },
  fieldLabel: { color: COLORS.ink, fontSize: 14, fontWeight: '700' },
  input: { minHeight: 50, borderWidth: 1, borderColor: '#CDD9D1', borderRadius: 12, paddingHorizontal: 13, color: COLORS.ink, backgroundColor: '#FFFFFF', fontSize: 16 },
  multilineInput: { minHeight: 92, paddingTop: 12 },
  button: { minHeight: 50, borderRadius: 13, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, backgroundColor: COLORS.green },
  buttonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800', textAlign: 'center' },
  buttonSecondary: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#B9CFC1' },
  buttonSecondaryText: { color: COLORS.greenDark },
  buttonDanger: { backgroundColor: COLORS.danger },
  buttonSmall: { minHeight: 48, paddingHorizontal: 13 },
  buttonDisabled: { opacity: 0.45 },
  buttonPressed: { opacity: 0.82, transform: [{ scale: 0.99 }] },
  inlineSpinner: { marginTop: 2 },
  errorBanner: { backgroundColor: COLORS.dangerPale, borderColor: '#E8C1BC', borderWidth: 1, padding: 11, marginHorizontal: 16, marginTop: 10, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  errorText: { color: COLORS.danger, fontSize: 14, lineHeight: 20, flex: 1, fontWeight: '600' },
  noticeBanner: { backgroundColor: COLORS.greenPale, borderColor: '#C4E1D0', borderWidth: 1, padding: 11, marginHorizontal: 16, marginTop: 10, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  noticeText: { color: COLORS.greenDark, fontSize: 13, lineHeight: 19, flex: 1, fontWeight: '600' },
  dismissButton: { minHeight: 48, minWidth: 60, justifyContent: 'center', alignItems: 'center' },
  dismissText: { color: COLORS.danger, fontSize: 12, fontWeight: '800' },
  sectionHeading: { color: COLORS.ink, fontSize: 19, fontWeight: '800', marginTop: 8 },
  matchPress: { width: '100%' },
  matchCard: { gap: 13 },
  telemetryBanner: {
    minHeight: 42,
    paddingHorizontal: 11,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: COLORS.line,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6
  },
  telemetryLeft: { flexDirection: 'row', alignItems: 'center', gap: 7, flex: 1, minWidth: 0 },
  telemetryDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#10B981' },
  telemetryDotOffline: { backgroundColor: '#94A3B8' },
  telemetryText: { color: '#475569', fontSize: 10, fontWeight: '700', flexShrink: 1 },
  telemetryQueue: { color: '#334155', fontSize: 9, fontWeight: '800', backgroundColor: '#F1F5F9', paddingHorizontal: 7, paddingVertical: 5, borderRadius: 10 },
  fixtureHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  refreshButton: { width: 48, height: 48, borderRadius: 13, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center' },
  refreshButtonText: { color: COLORS.green, fontSize: 25, fontWeight: '700', lineHeight: 29 },
  filterRow: { gap: 8, paddingVertical: 2 },
  filterChip: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 13, borderRadius: 24, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: COLORS.line },
  filterChipSelected: { backgroundColor: COLORS.green, borderColor: COLORS.green },
  filterChipText: { color: '#475569', fontSize: 12, fontWeight: '700', textTransform: 'capitalize' },
  filterChipTextSelected: { color: '#FFFFFF' },
  filterCount: { color: '#64748B', fontSize: 10, fontWeight: '800' },
  filterCountSelected: { color: '#D1FAE5' },
  featuredMatchCard: { padding: 0, overflow: 'hidden', borderRadius: 15 },
  featuredMatchHeader: { minHeight: 47, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, backgroundColor: '#F1F5F9', borderBottomWidth: 1, borderBottomColor: COLORS.line },
  featuredLiveBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 27, paddingHorizontal: 9, borderRadius: 14, backgroundColor: '#D1FAE5', borderWidth: 1, borderColor: '#A7F3D0' },
  featuredLiveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: COLORS.green },
  featuredLiveText: { color: COLORS.greenDark, fontSize: 10, fontWeight: '800', textTransform: 'uppercase' },
  featuredTeamsRow: { minHeight: 153, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 11, paddingVertical: 16, gap: 5 },
  featuredTeam: { flex: 1, minWidth: 0, alignItems: 'center', gap: 7 },
  teamEmblem: { width: 46, height: 46, borderRadius: 13, backgroundColor: '#F1F5F9', borderWidth: 1, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center' },
  teamEmblemText: { color: COLORS.greenDark, fontSize: 13, fontWeight: '900', textTransform: 'uppercase' },
  featuredTeamName: { color: COLORS.ink, fontSize: 12, fontWeight: '800', textAlign: 'center' },
  featuredScoreBlock: { alignItems: 'center', gap: 7, paddingHorizontal: 3 },
  featuredScorePill: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 12, backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: COLORS.line },
  featuredScore: { color: COLORS.green, fontSize: 27, lineHeight: 32, fontWeight: '900', fontVariant: ['tabular-nums'] },
  featuredScoreDivider: { color: '#94A3B8', fontSize: 22, fontWeight: '400' },
  featuredTime: { color: '#64748B', fontSize: 9, textAlign: 'center' },
  featuredMatchFooter: { minHeight: 42, paddingHorizontal: 13, borderTopWidth: 1, borderTopColor: COLORS.line, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  featuredFooterText: { color: COLORS.green, fontSize: 11, fontWeight: '800' },
  featuredArrow: { color: COLORS.green, fontSize: 24, lineHeight: 26 },
  fixtureList: { gap: 8, marginTop: 2 },
  fixtureCount: { color: '#64748B', fontSize: 11, fontWeight: '700' },
  compactMatchCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: 12 },
  compactMatchInfo: { flex: 1, gap: 7 },
  compactMatchMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  compactMatchDate: { color: '#64748B', fontSize: 10 },
  compactTeamsRow: { alignItems: 'flex-end', gap: 5 },
  compactTeamNames: { alignItems: 'flex-end', gap: 3, maxWidth: 115 },
  matchMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  matchId: { fontSize: 12, color: COLORS.muted, fontWeight: '700', flex: 1 },
  scoreLine: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  teamName: { color: COLORS.ink, fontSize: 14, fontWeight: '700', flex: 1 },
  teamNameRight: { color: COLORS.ink, fontSize: 14, fontWeight: '700', textAlign: 'right', flex: 1 },
  score: { color: COLORS.greenDark, fontSize: 19, fontWeight: '900', fontVariant: ['tabular-nums'] },
  statusPill: { paddingHorizontal: 10, minHeight: 28, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  statusPillCompact: { paddingHorizontal: 8, minHeight: 24 },
  statusPositive: { backgroundColor: '#E8F5ED' },
  statusWarning: { backgroundColor: '#FFF4DB' },
  statusNeutral: { backgroundColor: '#EEF1EF' },
  statusText: { color: COLORS.ink, fontSize: 11, fontWeight: '800', textTransform: 'capitalize' },
  emptyCard: { alignItems: 'center', paddingVertical: 23, gap: 7 },
  emptyTitle: { color: COLORS.ink, fontSize: 16, fontWeight: '800' },
  liveScoreCard: { gap: 12, backgroundColor: '#F0F7F2' },
  largeScoreRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', gap: 8 },
  teamScore: { flex: 1, alignItems: 'center', gap: 3 },
  teamScoreName: { color: COLORS.muted, fontSize: 13, textAlign: 'center', fontWeight: '700' },
  teamScoreValue: { color: COLORS.greenDark, fontSize: 38, fontWeight: '900', fontVariant: ['tabular-nums'] },
  largeDash: { color: '#8B9A92', fontSize: 25, fontWeight: '700' },
  outcomeText: { color: COLORS.greenDark, fontSize: 14, textAlign: 'center', textTransform: 'capitalize', fontWeight: '800' },
  productSpotlight: { gap: 8, borderLeftWidth: 4, borderLeftColor: COLORS.gold },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  flexOne: { flex: 1 },
  cardTitle: { color: COLORS.ink, fontSize: 16, fontWeight: '800' },
  timelineCard: { gap: 6 },
  compensatedText: { color: COLORS.danger, fontSize: 12, fontWeight: '700' },
  standingCard: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
  rankBadge: { width: 34, height: 34, borderRadius: 12, backgroundColor: COLORS.greenPale, alignItems: 'center', justifyContent: 'center' },
  rankText: { color: COLORS.greenDark, fontWeight: '900', fontSize: 15 },
  standingMain: { flex: 1, gap: 3 },
  pointsBlock: { alignItems: 'center', minWidth: 42 },
  pointsValue: { color: COLORS.ink, fontSize: 20, fontWeight: '900' },
  clubHero: { gap: 6, backgroundColor: '#F0F7F2' },
  clubName: { color: COLORS.ink, fontSize: 24, fontWeight: '900' },
  listCard: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: COLORS.greenPale, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: COLORS.greenDark, fontWeight: '900', fontSize: 16 },
  productCard: { gap: 8 },
  priceText: { color: COLORS.greenDark, fontWeight: '900', fontSize: 17, marginTop: 4 },
  quantityControl: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  quantityButton: { minWidth: 48, minHeight: 48, borderRadius: 12, backgroundColor: COLORS.greenPale, alignItems: 'center', justifyContent: 'center' },
  quantitySymbol: { color: COLORS.greenDark, fontSize: 23, fontWeight: '800' },
  quantityValue: { minWidth: 20, textAlign: 'center', color: COLORS.ink, fontSize: 16, fontWeight: '800' },
  checkoutCard: { gap: 11 },
  totalText: { color: COLORS.ink, fontSize: 16, fontWeight: '800' },
  choiceRow: { flexDirection: 'row', gap: 9 },
  choiceWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { minHeight: 48, paddingHorizontal: 14, borderRadius: 13, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#FFFFFF', justifyContent: 'center', alignItems: 'center' },
  choiceSelected: { borderColor: COLORS.green, backgroundColor: COLORS.greenPale },
  choiceText: { color: COLORS.muted, fontSize: 14, fontWeight: '700' },
  choiceTextSelected: { color: COLORS.greenDark },
  receiptCard: { alignItems: 'center', gap: 11 },
  receiptCheck: { width: 54, height: 54, backgroundColor: COLORS.greenPale, borderRadius: 27, alignItems: 'center', justifyContent: 'center' },
  receiptCheckText: { color: COLORS.green, fontSize: 30, fontWeight: '900' },
  receiptTitle: { color: COLORS.ink, fontSize: 22, fontWeight: '900' },
  receiptTotal: { color: COLORS.greenDark, fontSize: 27, fontWeight: '900' },
  divider: { height: 1, backgroundColor: COLORS.line, alignSelf: 'stretch', marginVertical: 3 },
  helpText: { color: COLORS.muted, fontSize: 13, lineHeight: 19 },
  selectRow: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: COLORS.line },
  selectRowSelected: { backgroundColor: COLORS.greenPale, borderColor: COLORS.green },
  selectedText: { color: COLORS.greenDark, fontWeight: '800' },
  syncSummary: { gap: 12 },
  queueCard: { gap: 7, borderLeftWidth: 4, borderLeftColor: COLORS.gold },
  resultCard: { gap: 6 },
  cacheNote: { backgroundColor: '#FFF4DB', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  cacheNoteText: { color: '#735216', fontSize: 12, fontWeight: '700' },
  loadingRow: { minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11 },
  captionLogin: { marginTop: 8 }
});

export default AppShell;
