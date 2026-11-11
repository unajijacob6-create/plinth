# Turns the ElevenLabs /with-timestamps character alignment into word timings (seconds, source audio).
import json, sys
a = json.load(open(sys.argv[1]))['alignment']
words, cur, t0, t1 = [], '', None, None
for c, s, e in zip(a['characters'], a['character_start_times_seconds'], a['character_end_times_seconds']):
    if c.isspace():
        if cur: words.append({'w': cur, 's': round(t0, 3), 'e': round(t1, 3)}); cur = ''
        continue
    if not cur: t0 = s
    cur += c; t1 = e
if cur: words.append({'w': cur, 's': round(t0, 3), 'e': round(t1, 3)})
json.dump(words, open(sys.argv[2], 'w'), indent=0)
print(len(words), 'words')
