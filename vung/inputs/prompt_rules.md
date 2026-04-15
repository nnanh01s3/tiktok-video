# Prompt Rules — Rừng Xì Tin Scene Generation

Các rules này được pipeline đọc tự động khi sinh hình ảnh + video scene.
Chỉnh sửa file này để thay đổi prompt mà KHÔNG cần sửa code.

---

## IMAGE_HEADER

Generate a single cinematic still frame for a cute 3D Pixar cartoon animated short. Anthropomorphic animal characters only, no humans in the scene. No clothing on any character, natural animal bodies with fur/shell only. 9:16 vertical aspect ratio, vibrant magical forest environment, soft cinematic lighting.

## IMAGE_NEGATIVE

Avoid: humans, people, human hands, human faces, photorealism, real animals, dogs, cats, horses, duplicate characters, multiple instances of the same character, two of the same animal, twin characters, cloned characters, watermarks, logos, ANY TEXT in the image, ANY LETTERS, ANY WORDS, ANY Vietnamese text, ANY diacritics text, Korean text, Chinese text, English text, captions, subtitles, labels, speech bubbles, thought bubbles, floating text, title cards, Pixar watermark, TikTok caption, stock footage artifacts, clothing, shirts, pants, robes

## LINEUP_CALLOUT

Reference image 1 is a CHARACTER SIZE LINEUP showing correct height ratios — Bobo (bear) is tallest, Lala (fox) is medium, Momo (monkey) is small, Tiko (turtle) is shortest. Keep these size proportions.

## CHARACTER_MUST_SHOW

This scene MUST show exactly these characters: {characters}. Do not omit any character. Each character appears EXACTLY ONCE — no duplicates.

## CHARACTER_REF_CALLOUT

Reference image {index} is {name} — keep appearance IDENTICAL. This character must appear ONLY ONCE in the scene.

## CHARACTER_UNIQUENESS

ONLY ONE {name} in the scene. Do NOT duplicate this character. Each character is unique and appears exactly once.

## NO_TEXT_DIRECTIVE

ABSOLUTELY NO TEXT of any kind in the image. No letters, no words, no writing, no captions, no watermarks, no signs with text, no banners with text. The image must contain ZERO text characters. If text is needed it will be added separately via post-processing.

## VEO_STYLE

Phong cách pixar 3D cartoon, chuyển động mượt, màu sắc tươi.

## VEO_NO_NARRATION

QUAN TRỌNG: KHÔNG có lời dẫn chuyện, KHÔNG có voice-over tiếng Anh. Chỉ có nhân vật nói tiếng Việt giọng miền Nam và âm thanh môi trường rừng.

## VEO_CHARACTER_IDENTITY

QUAN TRỌNG VỀ NHÂN VẬT: Mỗi nhân vật phải giữ nguyên hình dạng, màu sắc, kích thước từ đầu đến cuối clip 8 giây. KHÔNG ĐƯỢC biến đổi nhân vật này thành nhân vật khác trong quá trình chuyển động. Ví dụ: nếu Momo (khỉ nâu) đang đứng trên cây thì khi nhảy xuống vẫn phải là Momo (khỉ nâu), KHÔNG được biến thành Tiko (rùa xanh). Giữ đúng species và màu sắc cho từng nhân vật xuyên suốt clip.

## VEO_NO_DUPLICATE

Mỗi nhân vật chỉ xuất hiện ĐÚNG MỘT LẦN trong khung hình. KHÔNG có hai con khỉ, KHÔNG có hai con cáo, KHÔNG có hai con gấu, KHÔNG có hai con rùa. Nếu scene có 4 nhân vật thì chỉ có đúng 4 con vật khác loài.

## TTS_ACCENT

Tất cả nhân vật nói giọng miền Nam Việt Nam (Southern Vietnamese accent). Giọng phải tự nhiên, rõ ràng, phù hợp tính cách nhân vật. Giữ đúng giọng miền Nam xuyên suốt tất cả các tập phim.

## ASPECT_RATIO

Tất cả hình ảnh và video PHẢI ở tỷ lệ 9:16 (1080x1920 pixel, vertical/portrait). Đây là chuẩn TikTok. Hình ảnh sinh ra từ Imagen sẽ được crop-to-fill (không pad viền đen) qua FFmpeg. Veo clip cũng phải config aspectRatio: "9:16". Cover image cho TikTok cũng phải 9:16.

## COVER_HEADER

Dynamic Pixar 3D cartoon cover art for a TikTok animated short episode. Eye-catching hero composition with the featured character(s) in a dynamic expressive pose that hints at the episode's story. Vibrant saturated colors, dramatic cinematic lighting, magical forest setting. Subject centered. Keep the TOP 220 pixels and BOTTOM 260 pixels of the 1080x1920 frame relatively uncluttered — those areas will be covered by text banners added in post-processing. 9:16 vertical aspect ratio.

## COVER_NEGATIVE

Avoid: humans, people, photorealism, real animals, dogs, cats, duplicate characters, multiple instances of same character, watermarks, logos, ANY TEXT in the image, ANY LETTERS, captions, subtitles, floating text, Pixar watermark, TikTok caption, stock footage artifacts, clothing, shirts, pants, robes

## COVER_TOP_BANNER

RỪNG XÌ TIN

## COVER_BOTTOM_BANNER_TEMPLATE

TẬP {episode}: {title}

## SPECIES_MAP

momo = chú khỉ
tiko = chú rùa
lala = cô cáo
bobo = chú gấu
