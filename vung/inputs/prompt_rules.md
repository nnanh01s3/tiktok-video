# Prompt Rules — Rừng Xì Tin Scene Generation

Các rules này được pipeline đọc tự động khi sinh hình ảnh scene.
Chỉnh sửa file này để thay đổi prompt mà KHÔNG cần sửa code.

---

## IMAGE_HEADER

Generate a single cinematic still frame for a cute 3D Pixar cartoon animated short. Anthropomorphic animal characters only, no humans in the scene. No clothing on any character, natural animal bodies with fur/shell only. 9:16 vertical aspect ratio, vibrant magical forest environment, soft cinematic lighting.

## IMAGE_NEGATIVE

Avoid: humans, people, human hands, human faces, photorealism, real animals, dogs, cats, horses, duplicate characters, multiple instances of the same character, watermarks, logos, ANY TEXT in the image, ANY LETTERS, ANY WORDS, Vietnamese text, Korean text, Chinese text, English text, captions, subtitles, labels, speech bubbles, thought bubbles, floating text, Pixar watermark, TikTok caption, stock footage artifacts, clothing, shirts, pants, robes

## LINEUP_CALLOUT

Reference image 1 is a CHARACTER SIZE LINEUP showing correct height ratios — Bobo (bear) is tallest, Lala (fox) is medium, Momo (monkey) is small, Tiko (turtle) is shortest. Keep these size proportions.

## CHARACTER_MUST_SHOW

This scene MUST show exactly these characters: {characters}. Do not omit any character.

## CHARACTER_REF_CALLOUT

Reference image {index} is {name} — keep appearance IDENTICAL.

## CHARACTER_UNIQUENESS

ONLY ONE {name}

## NO_TEXT_DIRECTIVE

NO TEXT, NO LETTERS, NO WRITING, NO CAPTIONS, NO WATERMARKS in the image

## VEO_STYLE

Phong cách pixar 3D cartoon, chuyển động mượt, màu sắc tươi.

## VEO_NO_NARRATION

QUAN TRỌNG: KHÔNG có lời dẫn chuyện, KHÔNG có voice-over tiếng Anh. Chỉ có nhân vật nói tiếng Việt và âm thanh môi trường rừng.

## SPECIES_MAP

momo = chú khỉ
tiko = chú rùa
lala = cô cáo
bobo = chú gấu
