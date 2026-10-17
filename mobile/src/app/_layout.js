import { Stack } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="login" />
        <Stack.Screen name="fixtures" />
        <Stack.Screen name="match/[match_id]" />
        <Stack.Screen name="standings" />
        <Stack.Screen name="club" />
        <Stack.Screen name="store" />
        <Stack.Screen name="roster" />
        <Stack.Screen name="scoring" />
        <Stack.Screen name="sync" />
        <Stack.Screen name="settings" />
      </Stack>
    </SafeAreaProvider>
  );
}
