Pod::Spec.new do |s|
  s.name           = 'aes_gcm'
  s.version        = '0.0.1'
  s.summary        = 'AES-256-GCM native module (Expo). 仕様書 §6.1 TP 登録 E2EE 用'
  s.homepage       = 'https://rootlens.io'
  s.license        = 'MIT'
  s.author         = 'RootLens'
  s.source         = { git: '' }
  s.platform       = :ios, '15.1'

  s.source_files   = '**/*.{swift,h,m}'

  s.frameworks = 'Foundation', 'CryptoKit'

  s.dependency 'ExpoModulesCore'
end
