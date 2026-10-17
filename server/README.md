# puuush server

Приём файлов от клиента [puuush](../README.md) и раздача их по ссылке.

Без него скриншот уезжает на чужой хостинг: catbox, pomf2, uguu. Ссылки там
вечные, но зависят от чужих сервисов и лежат на чужом железе. Свой сервер даёт
то же самое плюс контроль: ссылки не протухают, файлы лежат на твоём VPS, адрес
известен тебе.

Раздачу делает Caddy, не этот процесс. Приём здесь, учёт здесь, отдача это
`file_server` в общем конфиге. На этой машине так устроены все проекты, и
лишний Node в горячем пути только бы замедлял.

## API

| Метод | Путь | Ключ | Что делает |
|---|---|---|---|
| `POST` | `/v1/uploads` | write | принять файл, вернуть `{id, name, url, size, mime, sha256, created}` |
| `GET` | `/v1/uploads/{id}` | write | метаданные без тела |
| `DELETE` | `/v1/uploads/{id}` | write | удалить файл с диска |
| `GET` | `/v1/info` | write | сколько файлов и байт лежит, плюс лимиты |
| `GET` | `/v1/health` | нет | живость, для мониторинга |
| `GET` | `/f/{id}/{файл}` | нет | сам файл, отдаёт Caddy |

Ключ идёт заголовком:

```
Authorization: Bearer <write_key>
```

Это не украшение. Ключ в URL попадает в access-лог Caddy открытым текстом на
каждой загрузке. На этой машине с такой проблемой возились с блоком
`minimax-alisa`, там пришлось вырезать секрет из лога фильтром. Здесь её нет by
design.

### Доступ к файлу публичный, защита в неугадываемости

Ссылка выглядит так: `/f/54d8bc70c02436520b96dfca/ui-settings-0c1d65.png`.
`id` это 12 случайных байт, 96 бит энтропии. Перебрать невозможно. Поэтому
ключ отправки для просмотра и не нужен: человек получает ссылку в чат и
открывает где угодно без заголовков.

Приватный режим с отдельным `read_key` и проверкой через `forward_auth` здесь
не сделан. Для скриншотов он лишний.

### Ограничения

В конфиге: `max_bytes` на файл, `max_total_bytes` и `max_files` на всё
хранилище, `keep_days` на возраст. При переполнении уборщик удаляет самое
старое, свежие скриншоты переживают старые логи.

## Хранение

```
/srv/media/<24 hex символ>/<файл>
/srv/media/<24 hex символ>/meta.json
```

Без базы и без шардирования по подкаталогам. Лимит 5000 файлов, это ext4
переваривает без проблем, а `handle_path /f/*` в Caddy обходится без единого
регулярного выражения в конфиге, который обслуживает ещё шесть проектов.
Метаданные лежат рядом с файлом: терять нечего и бекапить нечего.

Имя файла приводится к латинице. Русское имя кодируется в процентах, и часть
чатов и загрузчиков такой URL обрезает. Кириллица схлопывается в
`file-<хвост хеша>.png`, чтобы два разных файла с одинаковым русским именем не
слились в один.

Временный файл пишется в целевой каталог, а не в общий `tmp`. `rename` атомарен
только внутри одного устройства.

## Запуск

```bash
sudo cp server/puuush-server.service /etc/systemd/system/
sudo systemctl enable --now puuush-server
sudo journalctl -u puuush-server -f
```

Конфиг лежит в `/srv/puuush-server/config.json` с правами `600`. Ключ
генерируется одной командой:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Юнит запускается от `ubuntu`, слушает `0.0.0.0:8099` и урезан через
`ProtectSystem=strict` с единственной разрешённой записью в `/srv/media`.

Порт открыт в ufw только для сети edge, так же как для cast-agent:

```bash
sudo ufw allow in from 172.40.0.0/24 to any port 8099 proto tcp
```

Из интернета 8099 закрыт. За HTTPS отвечает Caddy.

## Caddy

Блок в `/home/ubuntu/infra/caddy/Caddyfile`, уже применён:

```
media-trashbox.duckdns.org {
	handle /v1/* {
		reverse_proxy host.docker.internal:8099 { import proxy_headers }
	}
	handle_path /f/* { root * /srv/media; file_server }
	handle            { root * /srv/media; file_server }
}
```

Три маршрута, каждый отвечает за своё. Для `/v1/*` это `handle`, а не
`handle_path`: срезать префикс нельзя, сервер маршрутизирует по полному пути.
Со `handle_path` бэкенд получал `/health` вместо `/v1/health` и отвечал 404 на
всё, включая живость.

Последний `handle` с плоским `file_server` отдаёт ссылки, выданные до появления
API: они лежат прямо в корне `/srv/media`. Убирать его нельзя, иначе все ссылки
из старых чатов отдадут 404.

### Как править этот файл, чтобы ничего не сломать

Правь на месте, без переименования. Годятся `open(path,'w')` в Python, `>>`,
`tee`. Не годятся `sed -i`, `vim` и любой редактор, который сохраняет через
переименование: контейнер бинд-монтит один inode, после переименования монтаж
остаётся на старом файле, `caddy reload` радостно пишет «config is unchanged», а
сайт продолжает работать по старой конфигурации.

```bash
docker exec edge-caddy caddy reload --config /etc/caddy/Caddyfile
# и обязательно проверь, что рантайм действительно изменился:
docker exec edge-caddy sh -c \
  'wget -qO /tmp/c.json http://127.0.0.1:2019/config/ && grep -c "8099" /tmp/c.json'
```

Если показывает `0`, монтаж устарел и помогает только `docker restart edge-caddy`.

Перед правкой сделай копию:

```bash
sudo cp /home/ubuntu/infra/caddy/Caddyfile /home/ubuntu/infra/caddy/Caddyfile.bak.$(date +%s)
```

## Проверка

```bash
KEY=$(sudo python3 -c "import json;print(json.load(open('/srv/puuush-server/config.json'))['write_key'])")

# без ключа вернёт 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://media-trashbox.duckdns.org/v1/uploads -F "file=@s.png"

# с ключом
curl -s -X POST https://media-trashbox.duckdns.org/v1/uploads \
  -H "Authorization: Bearer $KEY" -F "file=@s.png"
```

Принимается и голое тело без multipart, если не хочется возиться с формой:

```bash
curl -X POST https://media-trashbox.duckdns.org/v1/uploads \
  -H "Authorization: Bearer $KEY" -H "X-Filename: screen.png" \
  --data-binary @screen.png
```

## На клиенте

В настройках puuush выбери режим `авто`, впиши адрес и ключ. Авторежим пробует
свой сервер первым и молча уходит во внешний хостинг, если тот недоступен или
отверг ключ, так что скриншот не пропадёт из-за сломанного сервера.

Режим `только свой box` полезен, когда утечка наружу недопустима: там любой
сбой видно сразу, а не прячется за откатом.