# Nemotron Persona Extractor Korea

GitHub Pages에서 바로 실행할 수 있는 정적 웹앱입니다. `nvidia/Nemotron-Personas-Korea` 원본 데이터셋에 연결해, 사용자가 선택한 특성에 맞는 합성 페르소나 row를 최대 1,000명까지 수집하고 엑셀로 저장합니다.

## 이번 수정 내용

`Failed to fetch` 오류를 줄이기 위해 다음 안정화 기능을 추가했습니다.

- API 요청 타임아웃 30초 적용
- 실패 시 자동 재시도 기본 5회
- 요청 간 지연 기본 700ms 적용
- 연속 오류 3회 발생 시 전체 앱이 멈추지 않고 부분 결과를 유지한 채 중단
- 실패 배치 수를 진행률 영역에 표시
- 검색 중 오류가 나도 이미 수집된 데이터는 엑셀로 저장 가능

브라우저가 외부 API를 직접 호출하는 GitHub Pages 구조이므로, Hugging Face 서버 상태, 네트워크 환경, 브라우저 보안 정책, 속도 제한에 따라 일시적인 실패가 발생할 수 있습니다. 오류가 반복되면 `요청 간 지연 ms`를 1000~1500으로 높이고 다시 실행하세요.

## 주요 기능

- 원하는 특성 선택
  - 지역
  - 나이
  - 성별
  - 직업 키워드
  - 가족 형태
  - 주거 형태
  - 교육 수준
  - 관심 키워드
  - 제품/서비스 주제
- Hugging Face 원본 데이터 검색
  - Dataset Viewer API `/rows` 엔드포인트 사용
  - 진행률, 수집 인원, 검색 행 수, API 성공/실패 수 표시
- 페르소나 카드 생성
  - 원본 데이터 기반 카드
  - UX 리서치용 카드
  - 가상 인터뷰 질문
  - 컨셉 반응 가설
- 엑셀 저장
  - `1_Raw_Data`: 수집한 원본 row
  - `2_Persona_Cards`: 페르소나 카드
  - `3_UX_Research`: UX 리서치용 요약
  - `4_Evidence_Summary`: 근거 분포 요약
  - `5_Search_Conditions`: 검색 조건

## GitHub Pages 배포 방법

1. 이 폴더의 파일을 새 GitHub 저장소에 업로드합니다.
   - `index.html`
   - `styles.css`
   - `app.js`
   - `README.md`
2. GitHub 저장소에서 `Settings` → `Pages`로 이동합니다.
3. `Build and deployment`에서 `Deploy from a branch`를 선택합니다.
4. Branch를 `main`, folder를 `/root`로 선택합니다.
5. 저장 후 몇 분 기다리면 GitHub Pages 주소가 생성됩니다.

## 사용 방법

1. 원하는 지역, 나이, 성별, 직업, 가족 형태, 주거 형태, 교육 수준, 관심 키워드를 입력합니다.
2. 제품/서비스 주제를 입력합니다.
3. 수집 목표 인원을 지정합니다. 최대값은 1,000명입니다.
4. 안정성을 위해 기본값 그대로 `요청 간 지연 ms = 700`, `재시도 횟수 = 5`를 권장합니다.
5. `원본 데이터 검색 시작` 버튼을 누릅니다.
6. 검색이 완료되거나 중간에 멈추면 `엑셀 저장` 버튼을 누릅니다.

## 오류가 반복될 때 권장 설정

- 목표 인원: 100~300명
- 검색할 최대 원본 행 수: 10,000~30,000행
- 요청 간 지연 ms: 1000~1500
- 실패 시 재시도 횟수: 5~8
- 연속 오류 중단 기준: 3~5

## 기술 구조

- 정적 웹앱: HTML, CSS, JavaScript
- 엑셀 저장: SheetJS CDN
- 데이터 연결: Hugging Face Dataset Viewer API
- 데이터셋: `nvidia/Nemotron-Personas-Korea`

## 주의 사항

- 이 데이터는 실제 개인 정보가 아니라 한국 통계 기반 합성 페르소나입니다.
- 앱은 원본 데이터를 브라우저에서 직접 조회합니다. 조건이 복잡하거나 검색 범위가 넓으면 시간이 걸릴 수 있습니다.
- Hugging Face Dataset Viewer API는 한 번에 최대 100행 단위로 조회하므로, 1,000명을 수집하려면 여러 번 API 호출이 필요합니다.
- 검색 결과와 컨셉 반응은 실제 사용자 조사 결과가 아니라 가설 생성용으로 사용해야 합니다.

## 라이선스 및 출처

- Dataset: https://huggingface.co/datasets/nvidia/Nemotron-Personas-Korea
- Dataset Viewer API: https://huggingface.co/docs/dataset-viewer/quick_start
