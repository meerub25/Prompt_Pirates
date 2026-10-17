import { useLocalSearchParams } from 'expo-router';
import AppShell from '../../components/AppShell';

function parameter(value) {
  return Array.isArray(value) ? value[0] : value;
}

export default function MatchRoute() {
  const params = useLocalSearchParams();
  const home = parameter(params.home);
  const away = parameter(params.away);
  const fixture = home && away
    ? {
        match_id: parameter(params.match_id),
        home,
        away,
        status: parameter(params.status) || 'upcoming',
        score: {
          home: Number(parameter(params.score_home) || 0),
          away: Number(parameter(params.score_away) || 0)
        }
      }
    : null;
  return <AppShell route="match" matchId={parameter(params.match_id)} fixture={fixture} />;
}
