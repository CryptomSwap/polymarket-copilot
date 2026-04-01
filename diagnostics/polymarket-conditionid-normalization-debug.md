# Polymarket conditionId normalization debug

- Generated: 2026-03-31T21:42:56.086Z
- Synced markets scanned: 531
- Gamma markets scanned: 1998
- Unique synced conditionIds: 531
- Unique gamma conditionIds: 1998

## 1) SyncedMarket.conditionId sample (20)
| syncedMarketId | slug | conditionId raw | typeof | length |
| --- | --- | --- | --- | ---: |
| cmnama7257a0n34ubk0vhmxkx | will-leeds-finish-in-last-place-in-the-2025-26-english-premier-league | 0xb3cc4ab0123fa51c866b8ae828a19e2b14bb0f6b82848b3a63043003b4ceed06 | string | 66 |
| cmnama71f7a0134ubj4igeezr | will-west-ham-finish-in-last-place-in-the-2025-26-english-premier-league | 0xf7183feeb20e3dec52e4f9a9c0c7d0b667b3de92cc87c812653fbeef10aba8e1 | string | 66 |
| cmn84vzamb0sem49tw02l8lam | will-nottm-forest-finish-in-last-place-in-the-2025-26-english-premier-league | 0x35e719305f57b28babe3238a4d6c1761a49bd05d7832efc5d5292b4a2ae48a68 | string | 66 |
| cmn81hnx17r6mm49tx86wof4k | will-tottenham-finish-in-last-place-in-the-2025-26-english-premier-league | 0x21aeb90ea9f2c5a8bf85f30ff79d93b34e8ec48a2b1508c7f924d82144bda4a9 | string | 66 |
| cmn81hnwx7r6lm49t0y8tpwge | will-sunderland-finish-in-3rd-place-in-the-2025-26-english-premier-league | 0xf9b65db702055ddfad4255453c952a3ddebf6f1646a1c845b0c41afe34cb0f7c | string | 66 |
| cmn81hnwt7r6km49tp4jbizh2 | will-brentford-finish-in-3rd-place-in-the-2025-26-english-premier-league | 0xf50019861496ba6722d9adc7bff0066870398a02f7cc4f1353d1f0fe45510326 | string | 66 |
| cmn81hnwp7r6jm49t0ndz00k4 | will-fulham-finish-in-3rd-place-in-the-2025-26-english-premier-league | 0xabec0ddd9583e241468a90758b3fcc3960eefb80c47ce65b3a97857851fd145b | string | 66 |
| cmn81hnwl7r6im49tkpyw8aub | will-crystal-palace-finish-in-3rd-place-in-the-2025-26-english-premier-league | 0x34f45de49e878fbaeb4fd6c9185dd8497d93ccc93b1913dcfa5e597dfb6a2860 | string | 66 |
| cmn81hnwh7r6hm49tjcbj2w1y | will-everton-finish-in-3rd-place-in-the-2025-26-english-premier-league | 0x4d82d265eff4c3e5175660e795dc96919eda012163a4a29184caddbb48877531 | string | 66 |
| cmn81hnwd7r6gm49t4luvbbc8 | will-bournemouth-finish-in-3rd-place-in-the-2025-26-english-premier-league | 0x7f9eb9327201f36247365c258c28807731aac9cb9f9bf12efe535aca34944296 | string | 66 |
| cmn81hnw87r6fm49tcdj25r75 | will-brighton-finish-in-3rd-place-in-the-2025-26-english-premier-league | 0xf9327a9bb13c08222b5f973af24e22a7a6afe66060858d74b2e56a028a6cd4c5 | string | 66 |
| cmn81hnw57r6em49ts24embo1 | will-aston-villa-finish-in-3rd-place-in-the-2025-26-english-premier-league | 0x3416aba5dafcf7755acb879cbf776188ff595d49fbb525805f93072679836480 | string | 66 |
| cmn81hnw17r6dm49ts26ib08i | will-manchester-united-finish-in-3rd-place-in-the-2025-26-english-premier-league | 0x8fb5eeaca92f58e06aca46463213069e1716748e69b94589ebe954ac4f15c061 | string | 66 |
| cmn81hnvv7r6cm49tpsazqj7w | will-newcastle-finish-in-3rd-place-in-the-2025-26-english-premier-league | 0xf5dbd365001584d9457604036bfa8b00c72f5e46690d0dc621e6f2e048710204 | string | 66 |
| cmn6e93xvtbfo11tal2ds2zo1 | will-chelsea-finish-in-3rd-place-in-the-2025-26-english-premier-league | 0xbb0ba3f1ef411f87982ad268a046469b653a5cb7600f93cccd530aba2b93416a | string | 66 |
| cmn5rgjqao6dwexr06eq3ldtv | will-manchester-city-finish-in-3rd-place-in-the-2025-26-english-premier-league | 0xfc0785605c0ef1429cb98e3a9166bf86f4c315ee872722ea2af3da17946f0aec | string | 66 |
| cmn4k60y101zl12pn7qhc9293 | will-arsenal-finish-in-3rd-place-in-the-2025-26-english-premier-league | 0x07edfd243789d912ada9e7cc8def6215b73596201fd24fb87d212d41474c7943 | string | 66 |
| cmn4k60xv01zf12pn5tz2wc4j | will-liverpool-finish-in-3rd-place-in-the-2025-26-english-premier-league | 0xad5f8afc7b6b6dfd331fa1d9209b392f117be855044df3e65f0c9ed6712c33f6 | string | 66 |
| cmn2yut7w7e7qb1bzry95jlul | will-sunderland-finish-in-2nd-place-in-the-2025-26-english-premier-league | 0xfec04d672289e4586685113ffd7e8ef39436951c80eae4b52f75da30e1e8a10f | string | 66 |
| cmn2yut7r7e7pb1bzzl7qfehr | will-brentford-finish-in-2nd-place-in-the-2025-26-english-premier-league | 0xe7b6a69c0a909d7c597c9ec2c7a8824445cf8bbac5cb07f5299ae11d002bbae7 | string | 66 |

## 2) Join match counts by normalization strategy
| strategy | match count |
| --- | ---: |
| exact | 0 |
| trim | 0 |
| lowercase | 0 |
| strip_0x_both | 0 |
| ensure_0x_lower | 0 |
| suffix_64_hex | 0 |
| substring_contains | 0 |

## 3) Correct normalization rule
- none found

## 4) Example matched pairs (Gamma ↔ SyncedMarket)
- No matched pairs found.

## 5) Blunt conclusion
- conditionId fundamentally different -> needs mapping layer