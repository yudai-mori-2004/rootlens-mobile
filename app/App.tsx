import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import {
  useFonts,
  Fraunces_300Light,
  Fraunces_400Regular,
  Fraunces_500Medium,
  Fraunces_600SemiBold,
} from '@expo-google-fonts/fraunces';
import { PrivyProvider } from '@privy-io/expo';
import { PrivyElements } from '@privy-io/expo/ui';

import HomeScreen from './src/sandboxes/HomeScreen';
import { sandboxes } from './src/sandboxes/registry';

const ENV = process.env as Record<string, string | undefined>;
const PRIVY_APP_ID = ENV.EXPO_PUBLIC_PRIVY_APP_ID ?? '';
const PRIVY_CLIENT_ID = ENV.EXPO_PUBLIC_PRIVY_CLIENT_ID ?? '';

export type SandboxStackParamList = {
  Home: undefined;
} & { [K in string]: undefined };

const Stack = createNativeStackNavigator<SandboxStackParamList>();

const appNavTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: '#fafaf7',
    card: '#ffffff',
    border: '#dcd8d0',
    primary: '#0a1f44',
    text: '#0a1f44',
  },
};

export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    Fraunces_300Light,
    Fraunces_400Regular,
    Fraunces_500Medium,
    Fraunces_600SemiBold,
  });

  if (!fontsLoaded && !fontError) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fafaf7' }}>
        <ActivityIndicator color="#0a1f44" />
      </View>
    );
  }

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      clientId={PRIVY_CLIENT_ID}
      config={{
        embedded: {
          solana: {
            createOnLogin: 'users-without-wallets',
          },
        },
      }}
    >
      <SafeAreaProvider>
        <NavigationContainer theme={appNavTheme}>
          <Stack.Navigator
            screenOptions={{
              headerStyle: { backgroundColor: '#ffffff' },
              headerTintColor: '#0a1f44',
              headerTitleStyle: {
                fontFamily: 'Fraunces_500Medium',
                fontSize: 17,
                color: '#0a1f44',
              },
              headerShadowVisible: false,
              contentStyle: { backgroundColor: '#fafaf7' },
            }}
          >
            <Stack.Screen
              name="Home"
              component={HomeScreen}
              options={{ title: 'RootLens' }}
            />
            {sandboxes.map((s) => (
              <Stack.Screen
                key={s.id}
                name={s.id}
                component={s.screen}
                options={{ title: 'RootLens' }}
              />
            ))}
          </Stack.Navigator>
          <StatusBar style="dark" />
        </NavigationContainer>
      </SafeAreaProvider>
      <PrivyElements />
    </PrivyProvider>
  );
}
