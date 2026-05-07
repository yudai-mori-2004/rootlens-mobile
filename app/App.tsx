import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>RootLens</Text>
      <Text style={styles.version}>v0.0.1</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fafaf7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 32,
    fontWeight: '600',
    color: '#0a1f44',
  },
  version: {
    marginTop: 8,
    fontSize: 14,
    color: '#0a1f44',
    opacity: 0.6,
  },
});
